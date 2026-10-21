import type { Db } from './index.ts';
import { markUndone, pendingAuditForTurn, type AuditEntry } from './repos/audit.ts';
import { syncExerciseFts } from './repos/exercises.ts';
import { refreshItemMacros, refreshMealTotals } from './repos/nutrition.ts';
import { setSetting } from './repos/settings.ts';
import { nowUtcIso } from '../time.ts';

type UndoHandler = (db: Db, entry: AuditEntry, now: string) => void;

const parse = <T>(json: string | null): T | undefined =>
  json === null ? undefined : (JSON.parse(json) as T);

/** Entidade criada que tem soft delete: desfazer = marcar `deleted_at`. */
const softDelete =
  (table: string, after?: (db: Db, id: number) => void): UndoHandler =>
  (db, e, now) => {
    if (e.action === 'create')
      db.prepare(`UPDATE ${table} SET deleted_at = ? WHERE id = ?`).run(now, e.entity_id);
    else if (e.action === 'delete')
      db.prepare(`UPDATE ${table} SET deleted_at = NULL WHERE id = ?`).run(e.entity_id);
    else throw new Error(`undo de update não suportado para ${e.entity}`);
    after?.(db, e.entity_id);
  };

type RoutineSnapshot = {
  name: string;
  name_norm: string;
  notes: string | null;
  deleted_at: string | null;
  exercises: {
    position: number;
    exercise_id: number;
    target_sets: number | null;
    rep_min: number | null;
    rep_max: number | null;
  }[];
};

/** Restaura uma linha inteira a partir do snapshot `before` (colunas exceto id). */
function restoreRow(db: Db, table: string, id: number, before: Record<string, unknown>) {
  const cols = Object.keys(before).filter((k) => k !== 'id');
  db.prepare(`UPDATE ${table} SET ${cols.map((c) => `${c} = @${c}`).join(', ')} WHERE id = @id`).run({
    ...before,
    id,
  });
}

const restoreOrSoftDelete =
  (table: string, after?: (db: Db, id: number, now: string) => void): UndoHandler =>
  (db, e, now) => {
    if (e.action === 'update') {
      const before = parse<Record<string, unknown>>(e.before_json);
      if (!before) throw new Error(`undo de ${e.entity} sem estado anterior`);
      restoreRow(db, table, e.entity_id, before);
    } else softDelete(table)(db, e, now);
    after?.(db, e.entity_id, now);
  };

const mealOfItem = (db: Db, itemId: number) =>
  db.prepare('SELECT meal_id FROM meal_items WHERE id = ?').pluck().get(itemId) as number;

const HANDLERS: Record<string, UndoHandler> = {
  workout_session: restoreOrSoftDelete('workout_sessions'),
  set: restoreOrSoftDelete('sets'),
  cardio_session: softDelete('cardio_sessions'),
  exercise: softDelete('exercises', syncExerciseFts),
  exercise_alias: (db, e) => {
    const after = parse<{ alias_norm: string }>(e.after_json);
    if (e.action !== 'create' || !after) throw new Error('undo de apelido exige create com alias_norm');
    db.prepare('DELETE FROM exercise_aliases WHERE alias_norm = ?').run(after.alias_norm);
    syncExerciseFts(db, e.entity_id);
  },
  routine: (db, e, now) => {
    db.prepare('DELETE FROM routine_exercises WHERE routine_id = ?').run(e.entity_id);
    if (e.action === 'create') {
      db.prepare('UPDATE routines SET deleted_at = ? WHERE id = ?').run(now, e.entity_id);
      return;
    }
    const before = parse<RoutineSnapshot>(e.before_json);
    if (!before) throw new Error('undo de rotina sem estado anterior');
    db.prepare('UPDATE routines SET name = ?, name_norm = ?, notes = ?, deleted_at = ? WHERE id = ?').run(
      before.name,
      before.name_norm,
      before.notes,
      before.deleted_at,
      e.entity_id,
    );
    const ins = db.prepare(
      'INSERT INTO routine_exercises (routine_id, position, exercise_id, target_sets, rep_min, rep_max) VALUES (?, ?, ?, ?, ?, ?)',
    );
    for (const x of before.exercises)
      ins.run(e.entity_id, x.position, x.exercise_id, x.target_sets, x.rep_min, x.rep_max);
  },
  meal: restoreOrSoftDelete('meals'),
  meal_item: restoreOrSoftDelete('meal_items', (db, id, now) => {
    refreshItemMacros(db, id);
    refreshMealTotals(db, mealOfItem(db, id), now);
  }),
  meal_correction: (db, e) => {
    db.prepare('DELETE FROM meal_corrections WHERE id = ?').run(e.entity_id);
  },
  food: restoreOrSoftDelete('foods'),
  body_metric: softDelete('body_metrics'),
  coach_note: restoreOrSoftDelete('coach_notes'),
  food_portion: (db, e) => {
    db.prepare('DELETE FROM food_portions WHERE id = ?').run(e.entity_id);
  },
  setting: (db, e) => {
    const before = parse<{ key: string; value?: unknown }>(e.before_json);
    if (!before) throw new Error('undo de setting sem estado anterior');
    setSetting(db, before.key, before.value);
  },
};

export type UndoResult = { entries: number; byEntity: Record<string, number> };

/** Desfaz todas as escritas pendentes de um turno, em ordem inversa, numa transação. */
export function undoTurn(db: Db, turnId: number, now = nowUtcIso()): UndoResult {
  const result: UndoResult = { entries: 0, byEntity: {} };
  db.transaction(() => {
    for (const e of pendingAuditForTurn(db, turnId)) {
      const handler = HANDLERS[e.entity];
      if (!handler) throw new Error(`sem undo para a entidade ${e.entity}`);
      handler(db, e, now);
      markUndone(db, e.id, now);
      result.entries++;
      result.byEntity[e.entity] = (result.byEntity[e.entity] ?? 0) + 1;
    }
  })();
  return result;
}
