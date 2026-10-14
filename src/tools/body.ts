import { z } from 'zod';
import type { Db } from '../db/index.ts';
import { getSettingsByPrefix, setSetting } from '../db/repos/settings.ts';
import { sessionSets } from '../db/repos/training.ts';
import { formatDayMonth, resolveWhen } from '../time.ts';
import { defineTool, ok } from './registry.ts';

/** Chaves canônicas de meta (D-017) com limites de sanidade. */
export const GOAL_LIMITS = {
  kcal: { min: 800, max: 8000 },
  protein_g: { min: 20, max: 500 },
  steps: { min: 500, max: 100_000 },
  sleep_h: { min: 3, max: 14 },
  training_days: { min: 1, max: 7 },
  weight_rate_kg_wk: { min: -1.5, max: 1 },
  weight_target_kg: { min: 30, max: 300 },
} as const;
export type GoalKey = keyof typeof GOAL_LIMITS;
export const GOAL_KEYS = Object.keys(GOAL_LIMITS) as GoalKey[];

/** Apelidos PT-BR aceitos pelo /meta (D-017). */
export const GOAL_ALIASES: Record<string, GoalKey> = {
  kcal: 'kcal',
  calorias: 'kcal',
  proteina: 'protein_g',
  passos: 'steps',
  sono: 'sleep_h',
  treinos: 'training_days',
  ritmo_peso: 'weight_rate_kg_wk',
  peso_alvo: 'weight_target_kg',
};

export function getGoals(db: Db): Partial<Record<GoalKey, number>> {
  return getSettingsByPrefix(db, 'goal.') as Partial<Record<GoalKey, number>>;
}

export function goalRangeError(key: GoalKey, value: number): string | null {
  const { min, max } = GOAL_LIMITS[key];
  return value < min || value > max ? `${key} deve ficar entre ${min} e ${max}` : null;
}

export const setGoalTool = defineTool({
  name: 'set_goal',
  scope: 'write',
  description:
    'Define (ou remove, com value null) uma meta do usuário. Nunca presuma metas. ' +
    'Chaves: kcal, protein_g, steps, sleep_h, training_days, weight_rate_kg_wk (kg/semana, negativo = perder), weight_target_kg.',
  input: z
    .object({ key: z.enum(GOAL_KEYS as [GoalKey, ...GoalKey[]]), value: z.number().nullable() })
    .superRefine((v, c) => {
      const e = v.value === null ? null : goalRangeError(v.key, v.value);
      if (e) c.addIssue({ code: 'custom', path: ['value'], message: e });
    }),
  handler: (ctx, { key, value }) => {
    const before = setSetting(ctx.db, `goal.${key}`, value ?? undefined);
    ctx.audit('setting', 0, 'update', { key: `goal.${key}`, value: before }, { key: `goal.${key}`, value });
    return ok({ goals: getGoals(ctx.db) });
  },
});

export const getGoalsTool = defineTool({
  name: 'get_goals',
  scope: 'read',
  description: 'Metas atuais definidas pelo usuário (vazio = nenhuma meta).',
  input: z.object({}),
  handler: (ctx) => ok({ goals: getGoals(ctx.db) }),
});

type DayRow = { kcal: number; protein_g: number; carbs_g: number; fat_g: number; fiber_g: number };

/** Resumo do dia contábil (parcial na Fase 1: refeições somadas, treino, cardio, saúde, metas). */
export function daySummary(db: Db, localDate: string) {
  const meals = db
    .prepare(
      `SELECT id AS meal_id, meal_type, kcal, protein_g FROM meals
        WHERE local_date = ? AND deleted_at IS NULL ORDER BY eaten_at`,
    )
    .all(localDate) as { meal_id: number; meal_type: string | null; kcal: number; protein_g: number }[];
  const totals = db
    .prepare(
      `SELECT coalesce(sum(kcal),0) kcal, coalesce(sum(protein_g),0) protein_g, coalesce(sum(carbs_g),0) carbs_g,
              coalesce(sum(fat_g),0) fat_g, coalesce(sum(fiber_g),0) fiber_g
         FROM meals WHERE local_date = ? AND deleted_at IS NULL`,
    )
    .get(localDate) as DayRow;
  const goals = getGoals(db);
  const remaining: { kcal?: number; protein_g?: number } = {};
  if (goals.kcal !== undefined) remaining.kcal = Math.round(goals.kcal - totals.kcal);
  if (goals.protein_g !== undefined) remaining.protein_g = Math.round(goals.protein_g - totals.protein_g);

  const sessions = db
    .prepare(
      `SELECT ws.id, r.name AS routine FROM workout_sessions ws LEFT JOIN routines r ON r.id = ws.routine_id
        WHERE ws.local_date = ? AND ws.deleted_at IS NULL ORDER BY ws.started_at`,
    )
    .all(localDate) as { id: number; routine: string | null }[];
  const workout = sessions.length
    ? (() => {
        const sets = sessions.flatMap((s) => sessionSets(db, s.id));
        const names = db
          .prepare(
            `SELECT name_pt FROM exercises WHERE id IN (${[...new Set(sets.map((s) => s.exercise_id))].join(',') || 'NULL'})`,
          )
          .pluck()
          .all() as string[];
        const routine = sessions
          .map((s) => s.routine)
          .filter(Boolean)
          .join(', ');
        return {
          ...(routine ? { routine } : {}),
          sessions: sessions.length,
          work_sets: sets.filter((s) => s.set_type !== 'warmup').length,
          exercises: names,
        };
      })()
    : undefined;
  const cardio = db
    .prepare(
      `SELECT activity, duration_s, distance_m FROM cardio_sessions WHERE local_date = ? AND deleted_at IS NULL ORDER BY started_at`,
    )
    .all(localDate) as { activity: string; duration_s: number | null; distance_m: number | null }[];
  const health = db
    .prepare('SELECT steps, sleep_minutes, resting_hr, active_kcal FROM health_daily WHERE local_date = ?')
    .get(localDate) as Record<string, number | null> | undefined;
  const round = (n: number) => Math.round(n);
  return {
    local_date: localDate,
    date: formatDayMonth(localDate),
    meals: meals.map((m) => ({
      ...m,
      kcal: round(m.kcal),
      protein_g: round(m.protein_g),
      items: (
        db
          .prepare(
            'SELECT id AS item_id, label, grams FROM meal_items WHERE meal_id = ? AND deleted_at IS NULL ORDER BY position',
          )
          .all(m.meal_id) as { item_id: number; label: string; grams: number }[]
      ).map((i) => ({ ...i, grams: Math.round(i.grams) })),
    })),
    totals: {
      kcal: round(totals.kcal),
      protein_g: round(totals.protein_g),
      carbs_g: round(totals.carbs_g),
      fat_g: round(totals.fat_g),
      fiber_g: round(totals.fiber_g),
    },
    goals,
    ...(Object.keys(remaining).length ? { remaining } : {}),
    ...(workout ? { workout } : {}),
    ...(cardio.length
      ? {
          cardio: cardio.map((c) => ({
            activity: c.activity,
            ...(c.duration_s !== null ? { duration_min: Math.round(c.duration_s / 60) } : {}),
            ...(c.distance_m !== null ? { distance_km: Math.round(c.distance_m / 100) / 10 } : {}),
          })),
        }
      : {}),
    ...(health ? { health } : {}),
  };
}

export const getDaySummaryTool = defineTool({
  name: 'get_day_summary',
  scope: 'read',
  description:
    'Resumo de um dia contábil (padrão: hoje): refeições e macros vs. metas, o que falta, treino, cardio, passos e sono.',
  input: z.object({
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD')
      .optional(),
  }),
  handler: (ctx, { date }) =>
    ok(
      daySummary(
        ctx.db,
        resolveWhen(date, ctx.now, ctx.settings.cutoffHour, ctx.settings.timeZone).localDate,
      ),
    ),
});

export const bodyTools = [setGoalTool, getGoalsTool, getDaySummaryTool];
