import PQueue from 'p-queue';
import type { Channel, InboundMessage } from '../channels/types.ts';
import type { Db } from '../db/index.ts';
import {
  insertMessage,
  linkMessage,
  linkedEntitiesByExternalId,
  setMessagesTurn,
} from '../db/repos/messages.ts';
import type { Logger } from '../logger.ts';
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
      await reply(outcome.text, last.chatId, outcome.turnId, outcome.entities);
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

  async function handle(m: InboundMessage): Promise<void> {
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
      kind: m.imagePath ? 'image' : 'text',
      text: m.text,
      media_path: m.imagePath,
      created_at: m.at,
    });
    if (duplicate) {
      deps.logger.debug({ externalId: m.externalId }, 'mensagem duplicada ignorada');
      return;
    }

    const cmd = !m.imagePath && m.text ? parseCommand(m.text) : null;
    if (cmd?.name === 'relatorio' && deps.report) {
      const arg = cmd.args.toLowerCase();
      const kind = /^dia|hoje/.test(arg) ? 'daily' : /^m[eê]s/.test(arg) ? 'monthly' : 'weekly';
      deps.db.prepare("UPDATE messages SET status = 'processed' WHERE id = ?").run(id);
      await queue.add(async () => {
        await deps.channel.processing?.(m, true);
        try {
          const r = await deps.report!(kind);
          await reply(r.text, m.chatId, undefined, []);
          if (deps.channel.sendImage)
            for (const c of r.charts ?? [])
              await deps.channel.sendImage(c, null, m.chatId ? { to: m.chatId } : undefined);
          deps.db.prepare('UPDATE reports SET sent_at = ? WHERE id = ?').run(clock(), r.reportId);
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

  /** Reprocessa as mensagens de um turno que falhou ou foi adiado (job do scheduler). */
  async function retryTurn(turnId: number): Promise<boolean> {
    const msgs = deps.db
      .prepare(
        "SELECT id, text, media_path, quoted_external_id, created_at FROM messages WHERE turn_id = ? AND direction = 'in' AND status = 'failed' ORDER BY id",
      )
      .all(turnId) as {
      id: number;
      text: string | null;
      media_path: string | null;
      quoted_external_id: string | null;
      created_at: string;
    }[];
    if (!msgs.length) return false;
    const batch: Pending[] = msgs.map((x) => ({
      id: x.id,
      imageOnly: Boolean(x.media_path) && !x.text,
      msg: {
        externalId: `retry-${x.id}`,
        text: x.text,
        imagePath: x.media_path,
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
      debouncer?.flushNow();
      await queue.onIdle();
    },
  });
}
