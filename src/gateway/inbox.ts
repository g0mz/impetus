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
import type { RunTurn } from './turn-runner.ts';

export type InboxDeps = {
  db: Db;
  channel: Channel;
  registry: Registry;
  settings: ToolSettings;
  runTurn: RunTurn;
  logger: Logger;
  clock?: () => string;
};

/**
 * Fluxo de mensagem recebida (ARCHITECTURE.md §4.1) — versão da Fase 1, sem debounce/fila
 * (Fase 2): persiste (idempotente), comando "/" responde na hora, o resto vira turno.
 */
export function createInbox(deps: InboxDeps) {
  const clock = deps.clock ?? nowUtcIso;
  const channelName = deps.channel.name;

  async function reply(
    text: string,
    turnId: number | undefined,
    entities: { entity: string; entity_id: number }[],
  ) {
    const { externalId } = await deps.channel.send(text);
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

  return async function handle(m: InboundMessage): Promise<void> {
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
    if (cmd) {
      const res = runCommand(
        { db: deps.db, registry: deps.registry, settings: deps.settings, now: clock() },
        cmd.name,
        cmd.args,
      );
      if (res.turnId) setMessagesTurn(deps.db, [id], res.turnId, 'processed');
      else deps.db.prepare("UPDATE messages SET status = 'processed' WHERE id = ?").run(id);
      await reply(res.text, res.turnId, []);
      return;
    }

    const quoted = m.quotedExternalId
      ? linkedEntitiesByExternalId(deps.db, channelName, m.quotedExternalId)
      : [];
    await deps.channel.processing?.(m, true);
    try {
      const outcome = await deps.runTurn({
        userText: m.text ?? '',
        images: m.imagePath ? [m.imagePath] : [],
        inboundMessageIds: [id],
        ...(quoted.length ? { quoted } : {}),
      });
      await reply(outcome.text, outcome.turnId, outcome.entities);
    } finally {
      await deps.channel.processing?.(m, false);
    }
  };
}
