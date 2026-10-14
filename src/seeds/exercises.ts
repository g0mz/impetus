import { z } from 'zod';
import type { Db } from '../db/index.ts';
import {
  addAlias,
  rebuildExerciseFts,
  upsertExercise,
  type Equipment,
  type ExerciseCategory,
  type ExerciseInput,
  type LoadKind,
} from '../db/repos/exercises.ts';
import { MUSCLES, mapMuscleLists } from '../domain/training/muscles.ts';
import { normalize } from '../text/normalize.ts';
import { parseCsvObjects } from './csv.ts';

/** Registro do free-exercise-db (yuhonas, domínio público). */
export type FreeExercise = {
  id: string;
  name: string;
  force: string | null;
  mechanic: string | null;
  equipment: string | null;
  category: string;
  primaryMuscles: string[];
  secondaryMuscles: string[];
};

const CATEGORY: Record<string, ExerciseCategory> = {
  strength: 'strength',
  powerlifting: 'strength',
  'olympic weightlifting': 'strength',
  strongman: 'strength',
  stretching: 'mobility',
  cardio: 'cardio',
  plyometrics: 'other',
};

function mapEquipment(eq: string | null): Equipment | null {
  if (eq === null) return null;
  if (eq === 'barbell' || eq === 'e-z curl bar') return 'barbell';
  if (eq === 'dumbbell' || eq === 'cable' || eq === 'machine') return eq;
  if (eq === 'body only') return 'bodyweight';
  return 'other';
}

function defaultLoadKind(eq: Equipment | null): LoadKind {
  if (eq === 'dumbbell') return 'per_hand';
  if (eq === 'cable') return 'stack';
  return 'total';
}

export function fromFreeExercise(e: FreeExercise): ExerciseInput {
  const equipment = mapEquipment(e.equipment);
  const muscles = mapMuscleLists(e.primaryMuscles, e.secondaryMuscles, e);
  return {
    name_pt: e.name, // sem tradução ainda: nome em inglês até o CSV PT-BR cobrir (D-012)
    name_en: e.name,
    category: CATEGORY[e.category] ?? 'other',
    equipment,
    load_kind: defaultLoadKind(equipment),
    primary_muscles: muscles.primary,
    secondary_muscles: muscles.secondary,
    is_compound: e.mechanic === 'compound',
    increment_kg: null,
    source: 'free-exercise-db',
    source_id: e.id,
  };
}

const muscleList = z
  .string()
  .transform((s) => s.split('|').map((m) => m.trim()).filter(Boolean))
  .pipe(z.array(z.enum(MUSCLES)));

export const ptbrRowSchema = z.object({
  source_id: z.string().transform((s) => s.trim() || null),
  name_pt: z.string().trim().min(2),
  aliases: z.string().transform((s) => s.split('|').map((a) => a.trim()).filter(Boolean)),
  category: z.enum(['strength', 'cardio', 'mobility', 'other']),
  equipment: z.enum(['barbell', 'dumbbell', 'machine', 'cable', 'bodyweight', 'smith', 'other']),
  load_kind: z.enum(['total', 'per_hand', 'per_side', 'bodyweight_plus', 'assisted', 'stack']),
  is_compound: z.enum(['0', '1']).transform((v) => v === '1'),
  increment_kg: z
    .string()
    .transform((s) => (s.trim() === '' ? null : Number(s)))
    .pipe(z.number().positive().nullable()),
  primary_muscles: muscleList.pipe(z.array(z.enum(MUSCLES)).min(1)),
  secondary_muscles: muscleList,
});
export type PtbrRow = z.infer<typeof ptbrRowSchema>;

/** Valida o CSV PT-BR inteiro; erros listam a linha. Também barra apelidos repetidos entre exercícios. */
export function parsePtbrCsv(text: string, knownSourceIds: Set<string>): PtbrRow[] {
  const errors: string[] = [];
  const rows: PtbrRow[] = [];
  const aliasOwner = new Map<string, string>();
  parseCsvObjects(text).forEach((raw, i) => {
    const line = i + 2;
    const parsed = ptbrRowSchema.safeParse(raw);
    if (!parsed.success) {
      errors.push(`linha ${line}: ${parsed.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ')}`);
      return;
    }
    const row = parsed.data;
    if (row.source_id && !knownSourceIds.has(row.source_id)) {
      errors.push(`linha ${line}: source_id "${row.source_id}" não existe no free-exercise-db`);
    }
    for (const alias of [row.name_pt, ...row.aliases]) {
      const key = normalize(alias);
      const owner = aliasOwner.get(key);
      if (owner && owner !== row.name_pt) errors.push(`linha ${line}: apelido "${alias}" já usado por "${owner}"`);
      aliasOwner.set(key, row.name_pt);
    }
    rows.push(row);
  });
  if (errors.length) throw new Error(`exercises_ptbr.csv inválido:\n  - ${errors.join('\n  - ')}`);
  return rows;
}

export type ExerciseSeedReport = { imported: number; translated: number; custom: number; aliases: number };

/**
 * Importa todo o free-exercise-db e aplica por cima o CSV PT-BR (nome, apelidos, carga,
 * incremento e músculos curados). Idempotente: rodar de novo chega ao mesmo estado.
 */
export function seedExercises(db: Db, freeExercises: FreeExercise[], ptbrCsv: string): ExerciseSeedReport {
  const ptbr = parsePtbrCsv(ptbrCsv, new Set(freeExercises.map((e) => e.id)));
  const bySource = new Map(ptbr.filter((r) => r.source_id).map((r) => [r.source_id as string, r]));
  const report: ExerciseSeedReport = { imported: 0, translated: 0, custom: 0, aliases: 0 };

  const curated = (row: PtbrRow, base: Partial<ExerciseInput>): ExerciseInput => ({
    name_en: null,
    source: 'custom',
    source_id: null,
    ...base,
    name_pt: row.name_pt,
    category: row.category,
    equipment: row.equipment,
    load_kind: row.load_kind,
    is_compound: row.is_compound,
    increment_kg: row.increment_kg,
    primary_muscles: row.primary_muscles,
    secondary_muscles: row.secondary_muscles.filter((m) => !row.primary_muscles.includes(m)),
  });

  const addAliases = (row: PtbrRow, exerciseId: number) => {
    for (const alias of [row.name_pt, ...row.aliases]) {
      const res = addAlias(db, alias, exerciseId, 'seed');
      if (res === 'conflict') throw new Error(`apelido "${alias}" já pertence a outro exercício no banco`);
      if (res === 'added') report.aliases++;
    }
  };

  db.transaction(() => {
    for (const fe of freeExercises) {
      const row = bySource.get(fe.id);
      const base = fromFreeExercise(fe);
      const id = upsertExercise(db, row ? curated(row, base) : base);
      report.imported++;
      if (row) {
        report.translated++;
        addAliases(row, id);
      }
    }
    for (const row of ptbr.filter((r) => !r.source_id)) {
      const existing = db
        .prepare("SELECT id FROM exercises WHERE source = 'custom' AND lower(name_pt) = lower(?)")
        .pluck()
        .get(row.name_pt) as number | undefined;
      const input = curated(row, {});
      const id =
        existing ??
        upsertExercise(db, input);
      if (existing) {
        db.prepare(
          `UPDATE exercises SET category=@category, equipment=@equipment, load_kind=@load_kind, is_compound=@is_compound,
             increment_kg=@increment_kg, primary_muscles=@pm, secondary_muscles=@sm WHERE id=@id`,
        ).run({
          ...input,
          is_compound: input.is_compound ? 1 : 0,
          pm: JSON.stringify(input.primary_muscles),
          sm: JSON.stringify(input.secondary_muscles),
          id,
        });
      }
      report.custom++;
      addAliases(row, id);
    }
    rebuildExerciseFts(db);
  })();
  return report;
}
