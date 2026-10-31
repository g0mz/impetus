import type { Db } from '../index.ts';
import { nowUtcIso } from '../../time.ts';

export type AuditAction = 'create' | 'update' | 'delete';

export type AuditEntry = {
  id: number;
  turn_id: number | null;
  entity: string;
  entity_id: number;
  action: AuditAction;
  before_json: string | null;
  after_json: string | null;
};

export function recordAudit(
  db: Db,
  e: {
    turnId: number | null;
    entity: string;
    entityId: number;
    action: AuditAction;
    before?: unknown;
    after?: unknown;
  },
): void {
  db.prepare(
    `INSERT INTO audit_log (turn_id, entity, entity_id, action, before_json, after_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    e.turnId,
    e.entity,
    e.entityId,
    e.action,
    e.before === undefined ? null : JSON.stringify(e.before),
    e.after === undefined ? null : JSON.stringify(e.after),
    nowUtcIso(),
  );
}

/** Entradas ainda não desfeitas de um turno, da mais recente para a mais antiga. */
export function pendingAuditForTurn(db: Db, turnId: number): AuditEntry[] {
  return db
    .prepare('SELECT * FROM audit_log WHERE turn_id = ? AND undone_at IS NULL ORDER BY id DESC')
    .all(turnId) as AuditEntry[];
}

/** Último turno com escritas ainda não desfeitas. */
export function lastTurnWithPendingWrites(db: Db): number | undefined {
  return db
    .prepare(
      "SELECT turn_id FROM audit_log WHERE undone_at IS NULL AND turn_id IS NOT NULL AND entity <> 'vault_note' ORDER BY id DESC LIMIT 1",
    )
    .pluck()
    .get() as number | undefined;
}

export function markUndone(db: Db, auditId: number, now = nowUtcIso()): void {
  db.prepare('UPDATE audit_log SET undone_at = ? WHERE id = ?').run(now, auditId);
}

/** Entidades criadas ou alteradas por um turno (para `message_links`), sem repetição. */
export function touchedEntities(db: Db, turnId: number): { entity: string; entity_id: number }[] {
  return db
    .prepare(
      `SELECT DISTINCT entity, entity_id FROM audit_log
        WHERE turn_id = ? AND undone_at IS NULL AND action IN ('create','update')`,
    )
    .all(turnId) as { entity: string; entity_id: number }[];
}
