import fs from 'node:fs';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  type WAMessage,
  type WASocket,
} from 'baileys';
import PQueue from 'p-queue';
import type { Logger } from '../logger.ts';
import { saveNormalizedImage } from '../media/images.ts';
import {
  splitMessage,
  type Channel,
  type InboundHandler,
  type InboundMessage,
  type SendOptions,
} from './types.ts';
import { parseWaMessage, type WaLike } from './wa-parse.ts';

export type WhatsAppOptions = {
  authDir: string;
  mediaDir: string;
  sendMinIntervalMs: number;
  logger: Logger;
  /** Chat padrão para mensagens proativas (do settings owner.chat_jid). */
  defaultTo: () => string | undefined;
};

/** Cria o socket do Baileys com a sessão em `authDir` (credencial: modo 700, fora do backup). */
export async function createSocket(authDir: string, logger: Logger) {
  fs.mkdirSync(authDir, { recursive: true, mode: 0o700 });
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  let version: [number, number, number] | undefined;
  try {
    version = (await fetchLatestBaileysVersion()).version;
  } catch {
    version = undefined;
  }
  const sock = makeWASocket({
    auth: state,
    browser: Browsers.ubuntu('Impetus'),
    logger: logger.child({ mod: 'baileys' }, { level: 'warn' }) as never,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    ...(version ? { version } : {}),
  });
  sock.ev.on('creds.update', saveCreds);
  return sock;
}

/**
 * Canal WhatsApp (Baileys): reconexão com backoff, envio serial com intervalo mínimo,
 * reação 👀 + "digitando…", download e normalização de imagens, id da mensagem citada.
 */
export function createWhatsAppChannel(opts: WhatsAppOptions): Channel {
  const log = opts.logger;
  const sendQueue = new PQueue({ concurrency: 1, interval: opts.sendMinIntervalMs, intervalCap: 1 });
  const raw = new Map<string, WAMessage>(); // mensagens recebidas recentes (para reagir)
  let sock: WASocket | undefined;
  let state: 'connecting' | 'open' | 'closed' | 'logged_out' = 'connecting';
  let since: string | null = null;
  let stopped = false;
  let backoff = 1000;
  let lastChat: string | undefined;
  let onMessage: InboundHandler = async () => {};
  let resolveDone: () => void = () => {};

  const target = (o?: SendOptions) => o?.to ?? lastChat ?? opts.defaultTo();

  async function connect(): Promise<void> {
    state = 'connecting';
    const s = await createSocket(opts.authDir, log);
    sock = s;
    s.ev.on('connection.update', (u) => {
      if (u.connection === 'open') {
        state = 'open';
        since = new Date().toISOString();
        backoff = 1000;
        log.info('whatsapp conectado');
      }
      if (u.connection === 'close') {
        const code = (u.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output
          ?.statusCode;
        if (code === DisconnectReason.loggedOut) {
          state = 'logged_out';
          log.error('whatsapp: sessão encerrada (logged out). Rode `npm run wa:link` de novo.');
          return;
        }
        state = 'closed';
        if (stopped) return;
        const wait = backoff;
        backoff = Math.min(backoff * 2, 60_000);
        log.warn({ code, wait }, 'whatsapp desconectado; reconectando');
        setTimeout(() => void connect().catch((e) => log.error({ err: e }, 'falha ao reconectar')), wait);
      }
    });
    s.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const m of messages) void handleRaw(m);
    });
  }

  async function handleRaw(m: WAMessage) {
    const p = parseWaMessage(m as unknown as WaLike);
    if (!p) return;
    try {
      let imagePath: string | null = null;
      if (p.hasImage) {
        const buf = (await downloadMediaMessage(m, 'buffer', {})) as Buffer;
        imagePath = await saveNormalizedImage(buf, opts.mediaDir);
      }
      raw.set(p.id, m);
      if (raw.size > 200) raw.delete(raw.keys().next().value as string);
      const msg: InboundMessage = {
        externalId: p.id,
        senderIds: p.senderIds,
        chatId: p.chatId,
        text: p.hasAudio && !p.text ? null : p.text,
        imagePath,
        quotedExternalId: p.quotedId,
        at: p.at,
      };
      if (!msg.text && !msg.imagePath) return; // áudio: Fase 7
      await onMessage(msg);
    } catch (e) {
      log.error({ err: e, id: p.id }, 'whatsapp: falha ao processar mensagem');
    }
  }

  async function sendParts(to: string, parts: string[]) {
    const ids: string[] = [];
    for (const text of parts) {
      const r = await sendQueue.add(() => sock!.sendMessage(to, { text }));
      if (r?.key.id) ids.push(r.key.id);
    }
    return ids;
  }

  return {
    name: 'whatsapp',
    async start(handler) {
      onMessage = async (m) => {
        await handler(m);
      };
      await connect();
      await new Promise<void>((r) => (resolveDone = r));
    },
    /** O gateway chama só para o dono; guardamos o chat para as respostas. */
    async processing(m, on) {
      if (!sock || !m.chatId) return;
      lastChat = m.chatId;
      try {
        if (on) {
          const key = raw.get(m.externalId)?.key;
          if (key) await sock.sendMessage(m.chatId, { react: { text: '👀', key } });
          await sock.sendPresenceUpdate('composing', m.chatId);
        } else await sock.sendPresenceUpdate('paused', m.chatId);
      } catch (e) {
        log.debug({ err: e }, 'whatsapp: falha no indicador de processamento');
      }
    },
    async send(text, o) {
      const to = target(o);
      if (!sock || !to) throw new Error('whatsapp: sem conexão ou sem destinatário');
      return { externalIds: await sendParts(to, splitMessage(text)) };
    },
    async sendImage(path, caption, o) {
      const to = target(o);
      if (!sock || !to) throw new Error('whatsapp: sem conexão ou sem destinatário');
      const r = await sendQueue.add(() =>
        sock!.sendMessage(to, { image: fs.readFileSync(path), ...(caption ? { caption } : {}) }),
      );
      return { externalIds: r?.key.id ? [r.key.id] : [] };
    },
    status() {
      return `${state}${since && state === 'open' ? ` desde ${since}` : ''}`;
    },
    async stop() {
      stopped = true;
      sock?.end(undefined);
      resolveDone();
    },
  };
}
