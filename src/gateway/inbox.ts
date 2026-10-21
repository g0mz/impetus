import PQueue from 'p-queue';
import { reactionOnly, type Channel, type InboundMessage } from '../channels/types.ts';
import type { Db } from '../db/index.ts';
import {
  insertMessage,
  linkMessage,
  linkedEntitiesByExternalId,
  setMessagesTurn,
} from '../db/repos/messages.ts';
import { t } from '../i18n/pt-br.ts';
import type { Logger } from '../logger.ts';
import type { Transcriber } from '../media/transcribe.ts';
import type { Registry, ToolSettings } from '../tools/registry.ts';
import { nowUtcIso } from '../time.ts';
import { parseCommand, runCommand } from './commands.ts';
import { createDebouncer } from './debounce.ts';
import type { OwnerGuard } from './owner-pairing.ts';
import type { RunTurn } from './turn-runner.ts';

export type InboxDeps = {
  db: Db;
  channel: Channel;
  registry: Registry;
  settings: ToolSettings;
  runTurn: RunTurn;
  logger: Logger;
  owner?: OwnerGuard;
  /** 0 = sem debounce (terminal e testes). */
  debounceMs?: number;
  debounceImageMs?: number;
  clock?: () => string;
  claudeTokenExpiresAt?: string;
  /** Transcrição de mensagens de voz; sem ela, áudio recebe uma resposta explicando. */
  transcribe?: Transcriber;
  /** Duração máxima aceita para áudio (s). */
  audioMaxSeconds?: number;
  /** /relatorio: gera na hora (usa o cérebro; fallback determinístico). */
  report?: (
    kind: 'daily' | 'weekly' | 'monthly',
  ) => Promise<{ text: string; reportId: number; charts?: string[] }>;
};

type Pending = { msg: InboundMessage; id: number; imageOnly: boolean };

/**
 * Fluxo de mensagem recebida (ARCHITECTURE.md §4.1–4.2): allowlist do dono → persiste (idempotente)
 * → comando "/" responde na hora → resto entra no debounce → fila serial de turnos no cérebro.
 */
export function createInbox(deps: InboxDeps) {
  const clock = deps.clock ?? nowUtcIso;
  const channelName = deps.channel.name;
  const queue = new PQueue({ concurrency: 1 });

  async function reply(
    text: string,
    to: string | undefined,
    turnId: number | undefined,
    entities: { entity: string; entity_id: number }[],
  ) {
    const { externalIds } = await deps.channel.send(text, to ? { to } : undefined);
    for (const externalId of externalIds) {
      const { id } = insertMessage(deps.db, {
        channel: channelName,
        direction: 'out',
        external_id: externalId,
        kind: 'text',
        text,
        turn_id: turnId ?? null,
      });
      if (entities.length) linkMessage(deps.db, id, entities);
    }
  }

  async function runBatch(batch: Pending[]) {
    const last = batch.at(-1)!.msg;
    const quotedExt = batch.map((b) => b.msg.quotedExternalId).find(Boolean);
    const quoted = quotedExt ? linkedEntitiesByExternalId(deps.db, channelName, quotedExt) : [];
    await deps.channel.processing?.(last, true);
    try {
      const outcome = await deps.runTurn({
        userText: batch
          .map((b) => b.msg.text)
          .filter(Boolean)
          .join('\n'),
        images: batch.map((b) => b.msg.imagePath).filter((p): p is string => Boolean(p)),
        inboundMessageIds: batch.map((b) => b.id),
        ...(quoted.length ? { quoted } : {}),
      });
      const emoji = outcome.status === 'done' ? reactionOnly(outcome.text) : null;
      if (emoji && (await deps.channel.react?.(last, emoji))) {
        // Guardada como mensagem de saída para o <recent_turns> mostrar a resposta do coach.
        insertMessage(deps.db, {
          channel: channelName,
          direction: 'out',
          external_id: `reaction:${last.externalId}`,
          kind: 'reaction',
          text: emoji,
          turn_id: outcome.turnId,
        });
      } else await reply(outcome.text, last.chatId, outcome.turnId, outcome.entities);
    } catch (e) {
      deps.logger.error({ err: e }, 'falha no turno');
    } finally {
      await deps.channel.processing?.(last, false);
    }
  }

  const enqueue = (batch: Pending[]) => queue.add(() => runBatch(batch));
  const debouncer =
    deps.debounceMs && deps.debounceMs > 0
      ? createDebouncer<Pending>({
          ms: deps.debounceMs,
          imageMs: deps.debounceImageMs ?? deps.debounceMs,
          onFlush: (b) => void enqueue(b),
        })
      : null;

  let transcribeChain: Promise<void> = Promise.resolve();
  let inboundChain: Promise<void> = Promise.resolve();

  /** Entrada serial: preserva a ordem (ex.: áudio sendo transcrito seguido de texto). */
  function handle(m: InboundMessage): Promise<void> {
    const run = inboundChain.then(() => handleOne(m));
    inboundChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function handleOne(m: InboundMessage): Promise<void> {
    if (deps.owner && m.senderIds) {
      const verdict = deps.owner.check(m.senderIds, m.text, m.chatId);
      if (verdict === 'ignore') return;
      if (verdict === 'paired') {
        await reply(
          '✅ Pareado! A partir de agora só respondo a você. Envie /ajuda.',
          m.chatId,
          undefined,
          [],
        );
        return;
      }
    }

    const { id, duplicate } = insertMessage(deps.db, {
      channel: channelName,
      direction: 'in',
      external_id: m.externalId,
      quoted_external_id: m.quotedExternalId,
      kind: m.audioPath ? 'audio' : m.imagePath ? 'image' : 'text',
      text: m.text,
      media_path: m.audioPath ?? m.imagePath,
      created_at: m.at,
    });
    if (duplicate) {
      deps.logger.debug({ externalId: m.externalId }, 'mensagem duplicada ignorada');
      return;
    }

    if (m.audioPath) {
      const text = await transcribeVoice(m, id);
      if (text === null) return;
      m = {
        ...m,
        text: m.text
          ? `${m.text}
🎤 ${text}`
          : `🎤 ${text}`,
        audioPath: null,
      };
    }

    const cmd = !m.imagePath && m.text && !m.text.startsWith('🎤') ? parseCommand(m.text) : null;
    if (cmd?.name === 'relatorio' && deps.report) {
      const arg = cmd.args.toLowerCase();
      const kind = /^dia|hoje/.test(arg) ? 'daily' : /^m[eê]s/.test(arg) ? 'monthly' : 'weekly';
      deps.db.prepare("UPDATE messages SET status = 'processed' WHERE id = ?").run(id);
      void queue.add(async () => {
        await deps.channel.processing?.(m, true);
        try {
          const r = await deps.report!(kind);
          await reply(r.text, m.chatId, undefined, []);
          if (deps.channel.sendImage)
            for (const c of r.charts ?? [])
              await deps.channel.sendImage(c, null, m.chatId ? { to: m.chatId } : undefined);
          deps.db.prepare('UPDATE reports SET sent_at = ? WHERE id = ?').run(clock(), r.reportId);
        } catch (e) {
          deps.logger.error({ err: e }, '/relatorio falhou');
          await reply(t.brainFailed, m.chatId, undefined, []).catch(() => undefined);
        } finally {
          await deps.channel.processing?.(m, false);
        }
      });
      return;
    }
    if (cmd) {
      const res = runCommand(
        {
          db: deps.db,
          registry: deps.registry,
          settings: deps.settings,
          now: clock(),
          ...(deps.channel.status ? { channelStatus: () => deps.channel.status!() } : {}),
          ...(deps.claudeTokenExpiresAt ? { claudeTokenExpiresAt: deps.claudeTokenExpiresAt } : {}),
        },
        cmd.name,
        cmd.args,
      );
      if (res.turnId) setMessagesTurn(deps.db, [id], res.turnId, 'processed');
      else deps.db.prepare("UPDATE messages SET status = 'processed' WHERE id = ?").run(id);
      await reply(res.text, m.chatId, res.turnId, []);
      return;
    }

    const item: Pending = { msg: m, id, imageOnly: Boolean(m.imagePath) && !m.text };
    if (debouncer) {
      debouncer.add(item);
      return;
    }
    await enqueue([item]);
  }

  /**
   * Transcreve a mensagem de voz (uma por vez: CPU) e grava o texto na mensagem. Devolve null se não deu
   * para transcrever (já respondeu ao usuário e marcou a mensagem).
   */
  async function transcribeVoice(m: InboundMessage, id: number): Promise<string | null> {
    const fail = async (text: string) => {
      deps.db.prepare("UPDATE messages SET status = 'processed' WHERE id = ?").run(id);
      await reply(text, m.chatId, undefined, []);
      return null;
    };
    if (!deps.transcribe) return fail(t.audioUnavailable);
    const max = deps.audioMaxSeconds ?? 180;
    if (m.audioSeconds && m.audioSeconds > max) return fail(t.audioTooLong(max));
    const job = transcribeChain.then(async () => {
      await deps.channel.processing?.(m, true);
      try {
        return await deps.transcribe!(m.audioPath!);
      } finally {
        await deps.channel.processing?.(m, false);
      }
    });
    transcribeChain = job.then(
      () => undefined,
      () => undefined,
    );
    const r = await job;
    if (!r.ok) {
      deps.logger.warn({ id, error: r.error }, 'transcrição falhou');
      return fail(t.audioFailed);
    }
    deps.logger.info({ id, ms: r.ms, chars: r.text.length }, 'áudio transcrito');
    deps.db.prepare('UPDATE messages SET text = ? WHERE id = ?').run(r.text, id);
    return r.text;
  }

  /** Reprocessa as mensagens de um turno que falhou ou foi adiado (job do scheduler). */
  async function retryTurn(turnId: number): Promise<boolean> {
    const msgs = deps.db
      .prepare(
        "SELECT id, kind, text, media_path, quoted_external_id, created_at FROM messages WHERE turn_id = ? AND direction = 'in' AND status = 'failed' ORDER BY id",
      )
      .all(turnId) as {
      id: number;
      kind: string;
      text: string | null;
      media_path: string | null;
      quoted_external_id: string | null;
      created_at: string;
    }[];
    if (!msgs.length) return false;
    // áudio: reenvia a transcrição já gravada (o arquivo .ogg não vai ao cérebro)
    const batch: Pending[] = msgs.map((x) => ({
      id: x.id,
      imageOnly: x.kind === 'image' && !x.text,
      msg: {
        externalId: `retry-${x.id}`,
        text: x.kind === 'audio' && x.text ? `🎤 ${x.text}` : x.text,
        imagePath: x.kind === 'image' ? x.media_path : null,
        quotedExternalId: x.quoted_external_id,
        at: x.created_at,
        ...(deps.owner?.defaultChat() ? { chatId: deps.owner.defaultChat()! } : {}),
      },
    }));
    await enqueue(batch);
    return true;
  }

  return Object.assign(handle, {
    retryTurn,
    /** Espera a fila esvaziar (testes e desligamento). */
    async drain() {
      await inboundChain;
      debouncer?.flushNow();
      await queue.onIdle();
    },
  });
}
