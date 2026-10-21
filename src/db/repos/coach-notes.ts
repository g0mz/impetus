import type { Db } from '../index.ts';
import type { CoachNote, NoteKind } from '../../domain/coach/notes.ts';

export type CoachNoteRow = CoachNote & {
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  turn_id: number | null;
  deleted_at: string | null;
};

export function insertNote(
  db: Db,
  n: { kind: NoteKind; text: string; due_local_date: string | null; turn_id: number | null; now: string },
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO coach_notes (kind, text, due_local_date, created_at, updated_at, turn_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(n.kind, n.text, n.due_local_date, n.now, n.now, n.turn_id).lastInsertRowid,
  );
}

export function getNote(db: Db, id: number): CoachNoteRow | undefined {
  return db.prepare('SELECT * FROM coach_notes WHERE id = ?').get(id) as CoachNoteRow | undefined;
}

/** Notas ativas (não apagadas nem resolvidas), mais antigas primeiro. */
export function activeNotes(db: Db): CoachNoteRow[] {
  return db
    .prepare('SELECT * FROM coach_notes WHERE deleted_at IS NULL AND resolved_at IS NULL ORDER BY id')
    .all() as CoachNoteRow[];
}

export function softDeleteNote(db: Db, id: number, now: string): void {
  db.prepare('UPDATE coach_notes SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now, now, id);
}

export function resolveNoteRow(db: Db, id: number, now: string): void {
  db.prepare('UPDATE coach_notes SET resolved_at = ?, updated_at = ? WHERE id = ?').run(now, now, id);
}

/**
 * Limpeza periódica (Fase 8b): life_event resolvido há mais de 30 dias e observação parada há mais de
 * 90 dias vão para soft delete. Preferências só saem por pedido do usuário.
 */
export function pruneNotes(db: Db, now: string): number {
  const days = (n: number) => new Date(Date.parse(now) - n * 86400_000).toISOString();
  return db
    .prepare(
      `UPDATE coach_notes SET deleted_at = @now WHERE deleted_at IS NULL AND (
         (kind = 'life_event' AND resolved_at IS NOT NULL AND resolved_at < @d30) OR
         (kind = 'observation' AND updated_at < @d90))`,
    )
    .run({ now, d30: days(30), d90: days(90) }).changes;
}
