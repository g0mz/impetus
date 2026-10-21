import fs from 'node:fs';
import path from 'node:path';
import PQueue from 'p-queue';
import type { Logger } from '../logger.ts';
import { saveAudio } from '../media/audio.ts';
import { toChatFormat } from '../text/chat-format.ts';
import { saveNormalizedImage } from '../media/images.ts';
import { splitMessage, type Channel, type InboundHandler, type SendOptions } from './types.ts';
import { parseTgUpdate, tgMessageId, type TgUpdate } from './tg-parse.ts';

export type TelegramOptions = {
  token: string;
  mediaDir: string;
  logger: Logger;
  /** Chat padrão para mensagens proativas (do settings owner.chat_jid). */
  defaultTo: () => string | undefined;
  /** Allowlist barata: mídia de quem não é o dono nem é baixada. */
  mayHandle?: (senderIds: string[]) => boolean;
  /** Para testes. */
  fetchImpl?: typeof fetch;
  apiBase?: string;
};

type ApiResult<T> = { ok: boolean; result?: T; description?: string; error_code?: number };

/**
 * Canal Telegram (Bot API, long polling — nada exposto à internet). O offset só avança depois de
 * processar a mensagem: após reinício o Telegram reentrega o que faltou e o inbox deduplica pelo id.
 * O token nunca aparece em logs nem em mensagens de erro (as URLs o contêm).
 */
export function createTelegramChannel(opts: TelegramOptions): Channel {
  const log = opts.logger;
  const doFetch = opts.fetchImpl ?? fetch;
  const base = `${opts.apiBase ?? 'https://api.telegram.org'}`;
  const sendQueue = new PQueue({ concurrency: 1 });
  let state: 'connecting' | 'open' | 'error' | 'closed' = 'connecting';
  let since: string | null = null;
  let stopped = false;
  let offset = 0;
  let lastChat: string | undefined;
  let abort: AbortController | undefined;

  const target = (o?: SendOptions) => o?.to ?? lastChat ?? opts.defaultTo();

  async function call<T>(method: string, body?: Record<string, unknown> | FormData, signal?: AbortSignal) {
    let res: Response;
    try {
      res = await doFetch(`${base}/bot${opts.token}/${method}`, {
        method: 'POST',
        ...(body instanceof FormData
          ? { body }
          : { body: JSON.stringify(body ?? {}), headers: { 'content-type': 'application/json' } }),
        ...(signal ? { signal } : {}),
      });
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e;
      // Sem `cause`: o erro original pode carregar a URL, que contém o token.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(`telegram ${method}: falha de rede (${(e as Error).name})`);
    }
    const j = (await res.json().catch(() => ({ ok: false }))) as ApiResult<T>;
    if (!j.ok)
      throw new Error(`telegram ${method}: ${j.error_code ?? res.status} ${j.description ?? ''}`.trim());
    return j.result as T;
  }

  async function downloadFile(fileId: string): Promise<Buffer> {
    const f = await call<{ file_path?: string }>('getFile', { file_id: fileId });
    if (!f.file_path) throw new Error('telegram getFile: sem file_path');
    const res = await doFetch(`${base}/file/bot${opts.token}/${f.file_path}`);
    if (!res.ok) throw new Error(`telegram download: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async function handle(u: TgUpdate, onMessage: InboundHandler) {
    const p = parseTgUpdate(u);
    if (!p) return;
    if (opts.mayHandle && !opts.mayHandle(p.senderIds)) return;
    const imagePath = p.imageFileId
      ? await saveNormalizedImage(await downloadFile(p.imageFileId), opts.mediaDir)
      : null;
    const audioPath = p.audioFileId ? saveAudio(await downloadFile(p.audioFileId), opts.mediaDir) : null;
    if (!p.text && !imagePath && !audioPath) return;
    await onMessage({
      audioPath,
      audioSeconds: p.audioSeconds,
      externalId: p.id,
      senderIds: p.senderIds,
      chatId: p.chatId,
      text: p.text,
      imagePath,
      quotedExternalId: p.quotedId,
      at: p.at,
    });
  }

  async function poll(onMessage: InboundHandler) {
    let backoff = 1000;
    while (!stopped) {
      try {
        abort = new AbortController();
        const updates = await call<TgUpdate[]>(
          'getUpdates',
          { offset, timeout: 30, allowed_updates: ['message'] },
          abort.signal,
        );
        if (state !== 'open') {
          state = 'open';
          since = new Date().toISOString();
          log.info('telegram conectado');
        }
        backoff = 1000;
        for (const u of updates) {
          try {
            await handle(u, onMessage);
          } catch (e) {
            log.error({ err: e, update: u.update_id }, 'telegram: falha ao processar mensagem');
          }
          offset = u.update_id + 1;
        }
      } catch (e) {
        if (stopped) break;
        state = 'error';
        log.warn(
          { err: (e as Error).message, wait: backoff },
          'telegram: falha no polling; tentando de novo',
        );
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
    state = 'closed';
  }

  async function sendText(to: string, text: string) {
    const r = await sendQueue.add(() =>
      call<{ message_id: number }>('sendMessage', {
        chat_id: to,
        text,
        link_preview_options: { is_disabled: true },
      }),
    );
    return tgMessageId(to, r!.message_id);
  }

  return {
    name: 'telegram',
    async start(handler) {
      // Garante long polling (getUpdates falha com 409 se houver webhook configurado).
      await call('deleteWebhook', { drop_pending_updates: false }).catch((e: Error) =>
        log.warn({ err: e.message }, 'telegram: deleteWebhook falhou'),
      );
      await poll(handler);
    },
    async processing(m, on) {
      if (!m.chatId) return;
      lastChat = m.chatId;
      if (!on) return;
      try {
        const messageId = Number(m.externalId.split(':')[1]);
        await call('setMessageReaction', {
          chat_id: m.chatId,
          message_id: messageId,
          reaction: [{ type: 'emoji', emoji: '👀' }],
        });
        await call('sendChatAction', { chat_id: m.chatId, action: 'typing' });
      } catch (e) {
        log.debug({ err: (e as Error).message }, 'telegram: falha no indicador de processamento');
      }
    },
    async react(m, emoji) {
      if (!m.chatId) return false;
      try {
        await call('setMessageReaction', {
          chat_id: m.chatId,
          message_id: Number(m.externalId.split(':')[1]),
          reaction: [{ type: 'emoji', emoji }],
        });
        return true;
      } catch (e) {
        log.debug({ err: (e as Error).message }, 'telegram: falha ao reagir');
        return false;
      }
    },
    async send(text, o) {
      const to = target(o);
      if (!to) throw new Error('telegram: sem destinatário');
      const ids: string[] = [];
      for (const part of splitMessage(toChatFormat(text, 'plain'), 4000)) ids.push(await sendText(to, part));
      return { externalIds: ids };
    },
    async sendImage(file, caption, o) {
      const to = target(o);
      if (!to) throw new Error('telegram: sem destinatário');
      const form = new FormData();
      form.set('chat_id', to);
      if (caption) form.set('caption', caption.slice(0, 1024));
      form.set('photo', new Blob([fs.readFileSync(file)]), path.basename(file));
      const r = await sendQueue.add(() => call<{ message_id: number }>('sendPhoto', form));
      return { externalIds: [tgMessageId(to, r!.message_id)] };
    },
    status() {
      return `${state}${since && state === 'open' ? ` desde ${since}` : ''}`;
    },
    async stop() {
      stopped = true;
      abort?.abort();
    },
  };
}
