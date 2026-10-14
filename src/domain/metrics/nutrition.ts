import { mean, round } from './stats.ts';

export type DayNutrition = {
  local_date: string;
  meals: number;
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  fiber_g: number;
};
export type ItemOrigin = { origin: string; kcal: number };

/** Dia completo (§2.5): ≥ 3 refeições ou ≥ 70% da meta de kcal. */
export function isCompleteDay(d: Pick<DayNutrition, 'meals' | 'kcal'>, kcalGoal?: number): boolean {
  return d.meals >= 3 || (kcalGoal !== undefined && d.kcal >= 0.7 * kcalGoal);
}

export function nutritionSummary(
  days: DayNutrition[],
  goals: { kcal?: number; protein_g?: number },
  weightTrendKg: number | null,
) {
  const complete = days.filter((d) => isCompleteDay(d, goals.kcal));
  const proteinAvg = mean(complete.map((d) => d.protein_g));
  const hit =
    goals.protein_g !== undefined ? complete.filter((d) => d.protein_g >= 0.9 * goals.protein_g!).length : null;
  return {
    days_logged: days.filter((d) => d.meals > 0).length,
    complete_days: complete.length,
    kcal_avg: round(mean(complete.map((d) => d.kcal))),
    protein_avg: round(proteinAvg),
    protein_g_per_kg: proteinAvg !== null && weightTrendKg ? round(proteinAvg / weightTrendKg, 1) : null,
    protein_days_hit: hit,
    protein_adherence_pct: hit !== null && complete.length ? Math.round((hit / complete.length) * 100) : null,
  };
}

/** Qualidade do registro (§2.5): % da kcal vinda de itens informados/corrigidos/de rótulo. */
export function loggingQuality(items: ItemOrigin[]): number | null {
  const total = items.reduce((t, i) => t + i.kcal, 0);
  if (!total) return null;
  const good = items
    .filter((i) => ['user_stated', 'corrected', 'label'].includes(i.origin))
    .reduce((t, i) => t + i.kcal, 0);
  return Math.round((good / total) * 100);
}
