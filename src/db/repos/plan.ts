import type { Db } from '../index.ts';
import type { PlanOverride, RoutineRef, WeeklySchedule } from '../../domain/training/schedule.ts';

export type ScheduleRow = { weekday: number; routine_id: number };

export function scheduleRows(db: Db): ScheduleRow[] {
  return db
    .prepare('SELECT weekday, routine_id FROM routine_schedule ORDER BY weekday')
    .all() as ScheduleRow[];
}

/** Substitui a agenda inteira. */
export function replaceSchedule(db: Db, rows: ScheduleRow[], now: string): void {
  db.prepare('DELETE FROM routine_schedule').run();
  const ins = db.prepare('INSERT INTO routine_schedule (weekday, routine_id, updated_at) VALUES (?, ?, ?)');
  for (const r of rows) ins.run(r.weekday, r.routine_id, now);
}

const routineRef = (db: Db, id: number): RoutineRef =>
  ({
    id,
    name: db.prepare('SELECT name FROM routines WHERE id = ?').pluck().get(id) as string,
  }) satisfies RoutineRef;

export function loadSchedule(db: Db): WeeklySchedule {
  return new Map(scheduleRows(db).map((r) => [r.weekday, routineRef(db, r.routine_id)]));
}

type OverrideRow = {
  id: number;
  from_local_date: string;
  until_local_date: string;
  text: string;
  weekday_changes: string | null;
};

function toOverride(db: Db, r: OverrideRow): PlanOverride {
  const raw = r.weekday_changes ? (JSON.parse(r.weekday_changes) as Record<string, number | null>) : null;
  return {
    ...r,
    weekday_changes: raw
      ? new Map(Object.entries(raw).map(([wd, id]) => [Number(wd), id === null ? null : routineRef(db, id)]))
      : null,
  };
}

/** Ajustes não apagados que ainda não venceram em `localDate`. */
export function activeOverrides(db: Db, localDate: string): PlanOverride[] {
  return (
    db
      .prepare(
        `SELECT id, from_local_date, until_local_date, text, weekday_changes FROM plan_overrides
          WHERE deleted_at IS NULL AND until_local_date >= ? ORDER BY id`,
      )
      .all(localDate) as OverrideRow[]
  ).map((r) => toOverride(db, r));
}

export function insertOverride(
  db: Db,
  o: {
    from: string;
    until: string;
    text: string;
    changes: Record<string, number | null> | null;
    turnId: number | null;
    now: string;
  },
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO plan_overrides (from_local_date, until_local_date, text, weekday_changes, created_at, turn_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(o.from, o.until, o.text, o.changes ? JSON.stringify(o.changes) : null, o.now, o.turnId)
      .lastInsertRowid,
  );
}

export function getOverrideRow(db: Db, id: number): Record<string, unknown> | undefined {
  return db.prepare('SELECT * FROM plan_overrides WHERE id = ?').get(id) as
    Record<string, unknown> | undefined;
}
