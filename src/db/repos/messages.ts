import type { Db } from '../index.ts';
import { nowUtcIso } from '../../time.ts';

export type MessageInput = {
  channel: string;
  direction: 'in' | 'out';
  external_id: string | null;
  quoted_external_id?: string | null;
  kind: 'text' | 'image' | 'audio' | 'other';
  text: string | null;
  media_path?: string | null;
  turn_id?: number | null;
  status?: string;
  created_at?: string;
};

/** Grava a mensagem; se já existir (mesmo canal, direção e id externo), devolve o id existente. */
export function insertMessage(db: Db, m: MessageInput): { id: number; duplicate: boolean } {
  const res = db
    .prepare(
      `INSERT INTO messages (channel, direction, external_id, quoted_external_id, kind, text, media_path, turn_id, status, created_at)
       VALUES (@channel, @direction, @external_id, @quoted_external_id, @kind, @text, @media_path, @turn_id, @status, @created_at)
       ON CONFLICT (channel, direction, external_id) DO NOTHING`,
    )
    .run({
      quoted_external_id: null,
      media_path: null,
      turn_id: null,
      status: m.direction === 'in' ? 'received' : 'sent',
      created_at: nowUtcIso(),
      ...m,
    });
  if (res.changes) return { id: Number(res.lastInsertRowid), duplicate: false };
  const id = db
    .prepare('SELECT id FROM messages WHERE channel = ? AND direction = ? AND external_id = ?')
    .pluck()
    .get(m.channel, m.direction, m.external_id) as number;
  return { id, duplicate: true };
}

export function setMessagesTurn(db: Db, ids: number[], turnId: number, status: string): void {
  const st = db.prepare('UPDATE messages SET turn_id = ?, status = ? WHERE id = ?');
  for (const id of ids) st.run(turnId, status, id);
}

export function linkMessage(
  db: Db,
  messageId: number,
  entities: { entity: string; entity_id: number }[],
): void {
  const st = db.prepare(
    'INSERT OR IGNORE INTO message_links (message_id, entity, entity_id) VALUES (?, ?, ?)',
  );
  for (const e of entities) st.run(messageId, e.entity, e.entity_id);
}

/** Entidades ligadas à mensagem do bot citada pelo usuário (correção por citação). */
export function linkedEntitiesByExternalId(db: Db, channel: string, externalId: string) {
  return db
    .prepare(
      `SELECT l.entity, l.entity_id FROM message_links l JOIN messages m ON m.id = l.message_id
        WHERE m.channel = ? AND m.direction = 'out' AND m.external_id = ?`,
    )
    .all(channel, externalId) as { entity: string; entity_id: number }[];
}
