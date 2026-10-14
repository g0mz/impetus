import type { Db } from '../index.ts';
import { ftsExactQuery, ftsPrefixQuery, normalize } from '../../text/normalize.ts';
import { nowUtcIso } from '../../time.ts';
import type { Muscle } from '../../domain/training/muscles.ts';

import type { Equipment, ExerciseCategory, LoadKind } from '../../domain/training/types.ts';

export type { Equipment, ExerciseCategory, LoadKind };

export type ExerciseInput = {
  name_pt: string;
  name_en: string | null;
  category: ExerciseCategory;
  equipment: Equipment | null;
  load_kind: LoadKind;
  primary_muscles: Muscle[];
  secondary_muscles: Muscle[];
  is_compound: boolean;
  increment_kg: number | null;
  source: 'free-exercise-db' | 'custom';
  source_id: string | null;
};

export type ExerciseMatch = {
  id: number;
  name_pt: string;
  equipment: string | null;
  load_kind: string;
  score: number;
};

/** Insere ou atualiza pelo par (source, source_id). Exercícios custom sem source_id sempre inserem. */
export function upsertExercise(db: Db, e: ExerciseInput): number {
  const row = db
    .prepare(
      `INSERT INTO exercises (name_pt, name_en, category, equipment, load_kind, primary_muscles, secondary_muscles,
                              is_compound, increment_kg, source, source_id, created_at)
       VALUES (@name_pt, @name_en, @category, @equipment, @load_kind, @primary_muscles, @secondary_muscles,
               @is_compound, @increment_kg, @source, @source_id, @created_at)
       ON CONFLICT (source, source_id) DO UPDATE SET
         name_pt = excluded.name_pt, name_en = excluded.name_en, category = excluded.category,
         equipment = excluded.equipment, load_kind = excluded.load_kind,
         primary_muscles = excluded.primary_muscles, secondary_muscles = excluded.secondary_muscles,
         is_compound = excluded.is_compound, increment_kg = excluded.increment_kg
       RETURNING id`,
    )
    .get({
      ...e,
      primary_muscles: JSON.stringify(e.primary_muscles),
      secondary_muscles: JSON.stringify(e.secondary_muscles),
      is_compound: e.is_compound ? 1 : 0,
      created_at: nowUtcIso(),
    }) as { id: number };
  return row.id;
}

export function findExerciseIdBySource(db: Db, source: string, sourceId: string): number | undefined {
  return db
    .prepare('SELECT id FROM exercises WHERE source = ? AND source_id = ?')
    .pluck()
    .get(source, sourceId) as number | undefined;
}

export type AliasResult = 'added' | 'exists' | 'conflict';

/** Liga um apelido (normalizado) a um exercício. Não rouba apelido de outro exercício. */
export function addAlias(
  db: Db,
  alias: string,
  exerciseId: number,
  origin: 'seed' | 'user' | 'llm',
): AliasResult {
  const aliasNorm = normalize(alias);
  if (!aliasNorm) return 'exists';
  const current = db
    .prepare('SELECT exercise_id FROM exercise_aliases WHERE alias_norm = ?')
    .pluck()
    .get(aliasNorm) as number | undefined;
  if (current === exerciseId) return 'exists';
  if (current !== undefined) return 'conflict';
  db.prepare('INSERT INTO exercise_aliases (alias_norm, exercise_id, origin) VALUES (?, ?, ?)').run(
    aliasNorm,
    exerciseId,
    origin,
  );
  return 'added';
}

/** Reescreve a linha do FTS de um exercício (nomes + apelidos). */
export function syncExerciseFts(db: Db, exerciseId: number): void {
  const ex = db.prepare('SELECT name_pt, name_en, deleted_at FROM exercises WHERE id = ?').get(exerciseId) as
    { name_pt: string; name_en: string | null; deleted_at: string | null } | undefined;
  db.prepare('DELETE FROM exercises_fts WHERE rowid = ?').run(exerciseId);
  if (!ex || ex.deleted_at) return;
  const aliases = (
    db
      .prepare('SELECT alias_norm FROM exercise_aliases WHERE exercise_id = ?')
      .pluck()
      .all(exerciseId) as string[]
  ).join(' | ');
  db.prepare('INSERT INTO exercises_fts (rowid, name_pt, name_en, aliases) VALUES (?, ?, ?, ?)').run(
    exerciseId,
    ex.name_pt,
    ex.name_en,
    aliases,
  );
}

export function rebuildExerciseFts(db: Db): void {
  db.transaction(() => {
    db.prepare('DELETE FROM exercises_fts').run();
    const ids = db.prepare('SELECT id FROM exercises WHERE deleted_at IS NULL').pluck().all() as number[];
    for (const id of ids) syncExerciseFts(db, id);
  })();
}

type ExerciseRow = { id: number; name_pt: string; equipment: string | null; load_kind: string };

/**
 * Busca por nome ou apelido. Apelido exato vem primeiro (score 1); depois FTS com prefixos,
 * ordenado por bm25 (score decrescente por posição, heurístico).
 */
export function searchExercises(db: Db, query: string, limit = 5): ExerciseMatch[] {
  const lim = Math.min(Math.max(limit, 1), 10);
  const out: ExerciseMatch[] = [];
  const seen = new Set<number>();

  const exact = db
    .prepare(
      `SELECT e.id, e.name_pt, e.equipment, e.load_kind
         FROM exercise_aliases a JOIN exercises e ON e.id = a.exercise_id
        WHERE a.alias_norm = ? AND e.deleted_at IS NULL`,
    )
    .get(normalize(query)) as ExerciseRow | undefined;
  if (exact) {
    out.push({ ...exact, score: 1 });
    seen.add(exact.id);
  }

  // Palavras exatas antes de prefixos: "supino" não deve trazer "puxada supinada" na frente.
  const stmt = db.prepare(
    `SELECT e.id, e.name_pt, e.equipment, e.load_kind
       FROM exercises_fts JOIN exercises e ON e.id = exercises_fts.rowid
      WHERE exercises_fts MATCH ? AND e.deleted_at IS NULL
      ORDER BY bm25(exercises_fts, 1.0, 0.5, 1.0), length(e.name_pt)
      LIMIT ?`,
  );
  let rank = 0;
  for (const match of [ftsExactQuery(query), ftsPrefixQuery(query)]) {
    if (!match || out.length >= lim) continue;
    for (const r of stmt.all(match, lim + 1) as ExerciseRow[]) {
      if (seen.has(r.id) || out.length >= lim) continue;
      seen.add(r.id);
      out.push({ ...r, score: Math.max(0.1, Math.round((0.9 - 0.1 * rank++) * 100) / 100) });
    }
  }
  return out;
}

export function countExercises(db: Db): number {
  return db.prepare('SELECT count(*) FROM exercises WHERE deleted_at IS NULL').pluck().get() as number;
}
