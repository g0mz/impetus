import { mean, round, slope } from './stats.ts';

export type DayWeight = { local_date: string; weight_kg: number };
export type TrendPoint = DayWeight & { trend_kg: number };

const dayIndex = (d: string) => Date.parse(`${d}T00:00:00Z`) / 86400_000;

/**
 * Tendência de peso (REPORTS.md §2.3): média exponencial com α = 0,1 sobre as pesagens diárias
 * (dias sem pesagem não entram).
 */
export function weightTrend(weights: DayWeight[], alpha = 0.1): TrendPoint[] {
  const sorted = [...weights].sort((a, b) => a.local_date.localeCompare(b.local_date));
  let t: number | null = null;
  return sorted.map((w) => {
    t = t === null ? w.weight_kg : t + alpha * (w.weight_kg - t);
    return { ...w, trend_kg: t };
  });
}

/** Tendência no fim de um dia (última pesagem até a data). */
export function trendAt(trend: TrendPoint[], localDate: string): number | null {
  const last = trend.filter((t) => t.local_date <= localDate).at(-1);
  return last ? last.trend_kg : null;
}

/**
 * Taxa semanal (§2.3): inclinação da tendência nos últimos `days` dias até `end`, em kg/semana e
 * %PC/semana. Exige ≥ 8 pesagens na janela.
 */
export function weeklyRate(
  trend: TrendPoint[],
  end: string,
  days = 28,
): { kg_wk: number; pct_wk: number; n: number } | null {
  const from = dayIndex(end) - days + 1;
  const pts = trend.filter((t) => dayIndex(t.local_date) >= from && t.local_date <= end);
  if (pts.length < 8) return null;
  const s = slope(pts.map((p) => ({ x: dayIndex(p.local_date), y: p.trend_kg })));
  if (s === null) return null;
  const kgWk = s * 7;
  const base = mean(pts.map((p) => p.trend_kg))!;
  return { kg_wk: round(kgWk, 2)!, pct_wk: round((kgWk / base) * 100, 2)!, n: pts.length };
}

/**
 * Estimativa de manutenção (TDEE adaptativo, §2.3): kcal média dos dias completos − Δtendência × 7.700 / dias.
 * Exige ≥ 14 dias, ≥ 80% dos dias completos e ≥ 8 pesagens. É uma estimativa.
 */
export function maintenanceEstimate(input: {
  days: number;
  completeDaysKcal: number[];
  trendStart: number | null;
  trendEnd: number | null;
  weighIns: number;
}): number | null {
  const { days, completeDaysKcal, trendStart, trendEnd, weighIns } = input;
  if (days < 14 || completeDaysKcal.length < 0.8 * days || weighIns < 8) return null;
  if (trendStart === null || trendEnd === null) return null;
  return Math.round(mean(completeDaysKcal)! - ((trendEnd - trendStart) * 7700) / days);
}
