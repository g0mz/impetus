import type { Db } from '../index.ts';
import type { SetLike, SetType } from '../../domain/training/load.ts';
import type { LoadKind } from '../../domain/training/types.ts';
import { normalize } from '../../text/normalize.ts';

export type ExerciseInfo = {
  id: number;
  name_pt: string;
  equipment: string | null;
  load_kind: LoadKind;
  increment_kg: number | null;
  category: string;
};

export function getExercise(db: Db, id: number): ExerciseInfo | undefined {
  return db
    .prepare(
      'SELECT id, name_pt, equipment, load_kind, increment_kg, category FROM exercises WHERE id = ? AND deleted_at IS NULL',
    )
    .get(id) as ExerciseInfo | undefined;
}

// ── Rotinas ──────────────────────────────────────────────────────────────────────────────

export type RoutineRow = {
  id: number;
  name: string;
  name_norm: string;
  notes: string | null;
  deleted_at: string | null;
};
export type RoutineExerciseRow = {
  position: number;
  exercise_id: number;
  target_sets: number | null;
  rep_min: number | null;
  rep_max: number | null;
};

/** Rotina pelo nome (normalizado), inclusive apagada — o upsert a reaproveita. */
export function findRoutine(db: Db, name: string, includeDeleted = false): RoutineRow | undefined {
  return db
    .prepare(`SELECT * FROM routines WHERE name_norm = ? ${includeDeleted ? '' : 'AND deleted_at IS NULL'}`)
    .get(normalize(name)) as RoutineRow | undefined;
}

export function getRoutineExercises(db: Db, routineId: number): RoutineExerciseRow[] {
  return db
    .prepare(
      'SELECT position, exercise_id, target_sets, rep_min, rep_max FROM routine_exercises WHERE routine_id = ? ORDER BY position',
    )
    .all(routineId) as RoutineExerciseRow[];
}

export function routineExercisesWithNames(db: Db, routineId: number) {
  return db
    .prepare(
      `SELECT re.position, re.exercise_id, e.name_pt, re.target_sets, re.rep_min, re.rep_max
         FROM routine_exercises re JOIN exercises e ON e.id = re.exercise_id
        WHERE re.routine_id = ? ORDER BY re.position`,
    )
    .all(routineId) as (RoutineExerciseRow & { name_pt: string })[];
}

/** Snapshot completo (para auditoria e undo). */
export function routineSnapshot(db: Db, routine: RoutineRow) {
  return {
    name: routine.name,
    name_norm: routine.name_norm,
    notes: routine.notes,
    deleted_at: routine.deleted_at,
    exercises: getRoutineExercises(db, routine.id),
  };
}

export function insertRoutine(db: Db, name: string, now: string): number {
  return Number(
    db
      .prepare('INSERT INTO routines (name, name_norm, created_at) VALUES (?, ?, ?)')
      .run(name, normalize(name), now).lastInsertRowid,
  );
}

export function replaceRoutineExercises(
  db: Db,
  routineId: number,
  rows: Omit<RoutineExerciseRow, 'position'>[],
): void {
  db.prepare('DELETE FROM routine_exercises WHERE routine_id = ?').run(routineId);
  const ins = db.prepare(
    'INSERT INTO routine_exercises (routine_id, position, exercise_id, target_sets, rep_min, rep_max) VALUES (?, ?, ?, ?, ?, ?)',
  );
  rows.forEach((r, i) => ins.run(routineId, i + 1, r.exercise_id, r.target_sets, r.rep_min, r.rep_max));
}

// ── Sessões e séries ─────────────────────────────────────────────────────────────────────

export type SessionRow = {
  id: number;
  routine_id: number | null;
  started_at: string;
  local_date: string;
  source: string;
};

/** Sessão de treino mais recente do chat com a hora da última atividade (última série ou início). */
export function lastChatSession(db: Db): (SessionRow & { last_activity: string }) | undefined {
  return db
    .prepare(
      `SELECT ws.id, ws.routine_id, ws.started_at, ws.local_date, ws.source,
              COALESCE((SELECT max(s.created_at) FROM sets s WHERE s.session_id = ws.id AND s.deleted_at IS NULL), ws.started_at) AS last_activity
         FROM workout_sessions ws
        WHERE ws.deleted_at IS NULL AND ws.source = 'chat'
        ORDER BY last_activity DESC LIMIT 1`,
    )
    .get() as (SessionRow & { last_activity: string }) | undefined;
}

export function getSession(db: Db, id: number): SessionRow | undefined {
  return db
    .prepare(
      'SELECT id, routine_id, started_at, local_date, source FROM workout_sessions WHERE id = ? AND deleted_at IS NULL',
    )
    .get(id) as SessionRow | undefined;
}

export function insertSession(
  db: Db,
  s: { routine_id: number | null; started_at: string; local_date: string; notes: string | null; now: string },
): number {
  return Number(
    db
      .prepare(
        "INSERT INTO workout_sessions (routine_id, started_at, local_date, notes, source, created_at) VALUES (?, ?, ?, ?, 'chat', ?)",
      )
      .run(s.routine_id, s.started_at, s.local_date, s.notes, s.now).lastInsertRowid,
  );
}

export function setSessionRoutine(db: Db, sessionId: number, routineId: number): void {
  db.prepare('UPDATE workout_sessions SET routine_id = ? WHERE id = ? AND routine_id IS NULL').run(
    routineId,
    sessionId,
  );
}

export type StoredSet = SetLike & {
  id: number;
  exercise_id: number;
  exercise_order: number;
  set_index: number;
};

export function sessionSets(db: Db, sessionId: number): StoredSet[] {
  return db
    .prepare(
      `SELECT id, exercise_id, exercise_order, set_index, weight_kg, reps, rpe, set_type
         FROM sets WHERE session_id = ? AND deleted_at IS NULL ORDER BY exercise_order, set_index`,
    )
    .all(sessionId) as StoredSet[];
}

export function insertSet(
  db: Db,
  s: {
    session_id: number;
    exercise_id: number;
    exercise_order: number;
    set_index: number;
    weight_kg: number | null;
    reps: number | null;
    rpe: number | null;
    rir: number | null;
    set_type: SetType;
    notes: string | null;
    created_at: string;
  },
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO sets (session_id, exercise_id, exercise_order, set_index, weight_kg, reps, rpe, rir, set_type, notes, created_at)
         VALUES (@session_id, @exercise_id, @exercise_order, @set_index, @weight_kg, @reps, @rpe, @rir, @set_type, @notes, @created_at)`,
      )
      .run(s).lastInsertRowid,
  );
}

export type ExerciseSession = {
  session_id: number;
  local_date: string;
  routine: string | null;
  sets: SetLike[];
};

/** Últimas sessões em que o exercício apareceu (mais recente primeiro), excluindo uma sessão opcional. */
export function exerciseSessions(
  db: Db,
  exerciseId: number,
  limit: number,
  excludeSessionId?: number,
): ExerciseSession[] {
  const sessions = db
    .prepare(
      `SELECT ws.id AS session_id, ws.local_date, r.name AS routine
         FROM workout_sessions ws LEFT JOIN routines r ON r.id = ws.routine_id
        WHERE ws.deleted_at IS NULL AND ws.id != ?
          AND EXISTS (SELECT 1 FROM sets s WHERE s.session_id = ws.id AND s.exercise_id = ? AND s.deleted_at IS NULL)
        ORDER BY ws.started_at DESC LIMIT ?`,
    )
    .all(excludeSessionId ?? -1, exerciseId, limit) as Omit<ExerciseSession, 'sets'>[];
  const setsSt = db.prepare(
    `SELECT weight_kg, reps, rpe, set_type FROM sets
      WHERE session_id = ? AND exercise_id = ? AND deleted_at IS NULL ORDER BY set_index`,
  );
  return sessions.map((s) => ({ ...s, sets: setsSt.all(s.session_id, exerciseId) as SetLike[] }));
}

/** Todas as séries históricas do exercício fora de uma sessão (para PRs). */
export function exerciseHistory(db: Db, exerciseId: number, excludeSessionId: number): SetLike[] {
  return db
    .prepare(
      `SELECT s.weight_kg, s.reps, s.rpe, s.set_type FROM sets s
         JOIN workout_sessions ws ON ws.id = s.session_id AND ws.deleted_at IS NULL
        WHERE s.exercise_id = ? AND s.session_id != ? AND s.deleted_at IS NULL`,
    )
    .all(exerciseId, excludeSessionId) as SetLike[];
}

/** Últimas sessões de uma rotina (mais recente primeiro). */
export function routineSessions(db: Db, routineId: number, limit: number) {
  return db
    .prepare(
      `SELECT id, local_date, started_at FROM workout_sessions
        WHERE routine_id = ? AND deleted_at IS NULL ORDER BY started_at DESC LIMIT ?`,
    )
    .all(routineId, limit) as { id: number; local_date: string; started_at: string }[];
}

/** Sessões recentes (qualquer rotina), mais recente primeiro. */
export function recentSessions(db: Db, limit: number) {
  return db
    .prepare(
      `SELECT ws.id, ws.local_date, ws.started_at, r.name AS routine FROM workout_sessions ws
         LEFT JOIN routines r ON r.id = ws.routine_id
        WHERE ws.deleted_at IS NULL ORDER BY ws.started_at DESC LIMIT ?`,
    )
    .all(limit) as { id: number; local_date: string; started_at: string; routine: string | null }[];
}

/** Peso corporal mais recente registrado (base do peso efetivo em barra fixa/paralelas). */
export function latestBodyweight(db: Db): number | null {
  return (
    (db
      .prepare(
        'SELECT weight_kg FROM body_metrics WHERE weight_kg IS NOT NULL AND deleted_at IS NULL ORDER BY measured_at DESC LIMIT 1',
      )
      .pluck()
      .get() as number | undefined) ?? null
  );
}

export function insertCardio(
  db: Db,
  c: {
    local_date: string;
    started_at: string | null;
    activity: string;
    duration_s: number | null;
    distance_m: number | null;
    avg_hr: number | null;
    kcal: number | null;
    created_at: string;
  },
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO cardio_sessions (local_date, started_at, activity, duration_s, distance_m, avg_hr, kcal, source, created_at)
         VALUES (@local_date, @started_at, @activity, @duration_s, @distance_m, @avg_hr, @kcal, 'chat', @created_at)`,
      )
      .run(c).lastInsertRowid,
  );
}
