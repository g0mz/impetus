import type { Db } from '../db/index.ts';
import { getSetting, setSetting } from '../db/repos/settings.ts';
import { gramsCorrections } from '../db/repos/nutrition.ts';
import { MUSCLE_PT, runDetectors, type InsightCandidate } from '../domain/insights/detectors.ts';
import { restingHrTrend, sleepStats, stepsStats, type HealthDay } from '../domain/metrics/activity.ts';
import { maintenanceEstimate, trendAt, weeklyRate, weightTrend } from '../domain/metrics/body.ts';
import { loggingQuality, nutritionSummary, type DayNutrition } from '../domain/metrics/nutrition.ts';
import { pctChange, round } from '../domain/metrics/stats.ts';
import {
  e1rmHistory,
  periodTraining,
  prsInPeriod,
  sessionPerformance,
  setsByMuscle,
  sleepVsPerformance,
  stagnantExercises,
  topLifts,
  type TrainingSet,
} from '../domain/metrics/training.ts';
import { detectBias } from '../domain/nutrition/priors.ts';
import type { Muscle } from '../domain/training/muscles.ts';
import { getGoals } from '../tools/body.ts';
import { addDays, formatDayMonth, weekdayPt } from '../time.ts';

export type ReportKind = 'daily' | 'weekly' | 'monthly' | 'adhoc';
export type Period = { start: string; end: string };

const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

/** Período do relatório: diário = hoje; semanal = seg–dom da semana corrente; mensal = mês anterior. */
export function reportPeriod(kind: ReportKind, localToday: string): Period {
  if (kind === 'daily') return { start: localToday, end: localToday };
  if (kind === 'monthly') {
    const [y, m] = localToday.split('-').map(Number) as [number, number];
    const start = `${m === 1 ? y - 1 : y}-${String(m === 1 ? 12 : m - 1).padStart(2, '0')}-01`;
    return { start, end: addDays(`${y}-${String(m).padStart(2, '0')}-01`, -1) };
  }
  const wd = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'].indexOf(
    weekdayPt(localToday),
  );
  const start = addDays(localToday, -((wd + 6) % 7));
  return { start, end: addDays(start, 6) };
}

export function periodLabel(kind: ReportKind, p: Period): string {
  const [, sm, sd] = p.start.split('-');
  const [, em, ed] = p.end.split('-');
  if (kind === 'monthly') return `${MONTHS[Number(sm) - 1]}/${p.start.slice(0, 4)}`;
  if (kind === 'daily') return formatDayMonth(p.start);
  return sm === em
    ? `${sd}–${ed}/${MONTHS[Number(em) - 1]}`
    : `${sd}/${MONTHS[Number(sm) - 1]}–${ed}/${MONTHS[Number(em) - 1]}`;
}

const days = (p: Period) => Math.round((Date.parse(p.end) - Date.parse(p.start)) / 86400_000) + 1;

// ── carga de dados ────────────────────────────────────────────────────────────────────────

function loadSets(db: Db, from: string, to: string): TrainingSet[] {
  return (
    db
      .prepare(
        `SELECT s.session_id, ws.local_date, ws.started_at, s.exercise_id, e.name_pt AS exercise, e.load_kind,
                e.is_compound, e.primary_muscles, e.secondary_muscles, s.weight_kg, s.reps, s.rpe, s.set_type
           FROM sets s JOIN workout_sessions ws ON ws.id = s.session_id JOIN exercises e ON e.id = s.exercise_id
          WHERE s.deleted_at IS NULL AND ws.deleted_at IS NULL AND ws.local_date BETWEEN ? AND ?
          ORDER BY ws.started_at, s.exercise_order, s.set_index`,
      )
      .all(from, to) as (Omit<TrainingSet, 'primary' | 'secondary' | 'is_compound'> & {
      primary_muscles: string;
      secondary_muscles: string;
      is_compound: number;
    })[]
  ).map(({ primary_muscles, secondary_muscles, is_compound, ...r }) => ({
    ...r,
    is_compound: is_compound === 1,
    primary: JSON.parse(primary_muscles) as Muscle[],
    secondary: JSON.parse(secondary_muscles) as Muscle[],
  }));
}

function loadNutrition(db: Db, p: Period): DayNutrition[] {
  const rows = db
    .prepare(
      `SELECT local_date, count(*) meals, sum(kcal) kcal, sum(protein_g) protein_g, sum(carbs_g) carbs_g, sum(fat_g) fat_g,
              coalesce(sum(fiber_g),0) fiber_g
         FROM meals WHERE deleted_at IS NULL AND local_date BETWEEN ? AND ? GROUP BY local_date`,
    )
    .all(p.start, p.end) as DayNutrition[];
  return rows;
}

function loadHealth(db: Db, from: string, to: string): HealthDay[] {
  return db
    .prepare(
      'SELECT local_date, steps, sleep_minutes, sleep_start, sleep_end, resting_hr FROM health_daily WHERE local_date BETWEEN ? AND ? ORDER BY local_date',
    )
    .all(from, to) as HealthDay[];
}

function loadWeights(db: Db, to: string) {
  return db
    .prepare(
      `SELECT local_date, weight_kg FROM body_metrics b1
        WHERE weight_kg IS NOT NULL AND deleted_at IS NULL AND local_date <= ?
          AND measured_at = (SELECT max(measured_at) FROM body_metrics b2 WHERE b2.local_date = b1.local_date AND b2.weight_kg IS NOT NULL AND b2.deleted_at IS NULL)
        ORDER BY local_date`,
    )
    .all(to) as { local_date: string; weight_kg: number }[];
}

// ── brief ─────────────────────────────────────────────────────────────────────────────────

export type ReportBrief = {
  kind: ReportKind;
  period: Period & { label: string };
  goals: Record<string, number>;
  training: ReturnType<typeof periodTraining> & {
    prs: ReturnType<typeof prsInPeriod>;
    top_lifts: ReturnType<typeof topLifts>;
  };
  nutrition: ReturnType<typeof nutritionSummary> & {
    logging_quality_pct: number | null;
    days_in_period: number;
  };
  body: {
    weight_trend_start: number | null;
    weight_trend_end: number | null;
    rate_kg_wk: number | null;
    rate_pct_bw_wk: number | null;
    weigh_ins: number;
    maintenance_estimate: number | null;
  };
  activity: ReturnType<typeof stepsStats> & { cardio_min: number };
  sleep: ReturnType<typeof sleepStats>;
  today?: {
    kcal: number;
    protein_g: number;
    remaining_protein_g: number | null;
    trained: string | null;
    steps: number | null;
  };
  insights: InsightCandidate[];
  comparisons: { vs_previous_period: Record<string, string> };
};

export function buildReportBrief(db: Db, kind: ReportKind, period: Period, now: string): ReportBrief {
  const goals = getGoals(db);
  const n = days(period);
  const prevPeriod = { start: addDays(period.start, -n), end: addDays(period.start, -1) };
  const lookback = addDays(period.start, -120);

  const allSets = loadSets(db, lookback, period.end);
  const weights = loadWeights(db, period.end);
  const trend = weightTrend(weights);
  const bw = trendAt(trend, period.end);

  const training = periodTraining(allSets, period.start, period.end, bw);
  const prevTraining = periodTraining(allSets, prevPeriod.start, prevPeriod.end, bw);
  const nutDays = loadNutrition(db, period);
  const nutrition = nutritionSummary(nutDays, goals, bw);
  const prevNutrition = nutritionSummary(loadNutrition(db, prevPeriod), goals, bw);
  const items = db
    .prepare(
      `SELECT i.origin, i.kcal FROM meal_items i JOIN meals m ON m.id = i.meal_id
        WHERE i.deleted_at IS NULL AND m.deleted_at IS NULL AND m.local_date BETWEEN ? AND ?`,
    )
    .all(period.start, period.end) as { origin: string; kcal: number }[];

  const rate = weeklyRate(trend, period.end, Math.min(28, Math.max(14, n)));
  const tdeeWindow = { start: addDays(period.end, -27), end: period.end };
  const tdeeDays = loadNutrition(db, tdeeWindow).filter(
    (d) => d.meals >= 3 || (goals.kcal !== undefined && d.kcal >= 0.7 * goals.kcal),
  );
  const maintenance = maintenanceEstimate({
    days: 28,
    completeDaysKcal: tdeeDays.map((d) => d.kcal),
    trendStart: trendAt(trend, tdeeWindow.start),
    trendEnd: trendAt(trend, tdeeWindow.end),
    weighIns: weights.filter((w) => w.local_date >= tdeeWindow.start).length,
  });

  const health = loadHealth(db, period.start, period.end);
  const health28 = loadHealth(db, addDays(period.end, -27), period.end);
  const cardioMin = Math.round(
    ((db
      .prepare(
        "SELECT coalesce(sum(duration_s),0) FROM cardio_sessions WHERE deleted_at IS NULL AND local_date BETWEEN ? AND ? AND activity NOT LIKE '%(relógio)'",
      )
      .pluck()
      .get(period.start, period.end) as number) ?? 0) / 60,
  );
  const steps = stepsStats(health, goals.steps);
  const sleep = sleepStats(health, goals.sleep_h);

  // contexto extra dos detectores
  const weekly4: number[] = [];
  for (let w = 1; w <= 4; w++) {
    const s = addDays(period.start, -7 * w);
    weekly4.push(periodTraining(allSets, s, addDays(s, 6), bw).work_sets);
  }
  const hist4 = allSets.filter(
    (s) => s.local_date >= addDays(period.start, -28) && s.local_date < period.start,
  );
  const perf = sessionPerformance(allSets, bw);
  const sleepByDate = new Map(
    loadHealth(db, lookback, period.end)
      .filter((h) => h.sleep_minutes !== null)
      .map((h) => [h.local_date, h.sleep_minutes!]),
  );
  const prevMaintenance = getSetting<number>(db, 'metrics.maintenance_estimate') ?? null;
  const prs = prsInPeriod(allSets, period.start, period.end, bw);
  const insights = runDetectors({
    goals,
    prs,
    stagnant: stagnantExercises(allSets, period.end, bw),
    setsByMuscle: training.sets_by_muscle as Record<string, number>,
    musclesWithHistory: Object.keys(setsByMuscle(hist4)),
    pushPull: training.push_pull,
    workSets: training.work_sets,
    workSetsAvg4w: weekly4.some((x) => x > 0) ? weekly4.reduce((a, b) => a + b, 0) / 4 : null,
    nutrition,
    rateKgWk: rate?.kg_wk ?? null,
    maintenance,
    previousMaintenance: prevMaintenance,
    bias: detectBias(gramsCorrections(db), now),
    sleep,
    sleepPerf: sleepVsPerformance(
      perf.filter((p) => p.local_date >= addDays(period.end, -56)),
      sleepByDate,
      (goals.sleep_h ?? 7) * 60,
    ),
    steps,
    rhr: restingHrTrend(health28),
    hcLastSync:
      (db.prepare('SELECT max(received_at) FROM health_raw').pluck().get() as string | null) ?? null,
    now,
    periodDays: n,
  });
  if (kind !== 'daily' && maintenance !== null) setSetting(db, 'metrics.maintenance_estimate', maintenance);

  const cmp: Record<string, string> = {};
  const add = (k: string, a: number | null, b: number | null) => {
    const v = pctChange(a, b);
    if (v) cmp[k] = v;
  };
  add('work_sets', training.work_sets || null, prevTraining.work_sets || null);
  add('kcal_avg', nutrition.kcal_avg, prevNutrition.kcal_avg);
  add('protein_avg', nutrition.protein_avg, prevNutrition.protein_avg);
  add('steps_avg', steps.steps_avg, stepsStats(loadHealth(db, prevPeriod.start, prevPeriod.end)).steps_avg);

  const brief: ReportBrief = {
    kind,
    period: { ...period, label: periodLabel(kind, period) },
    goals: goals as Record<string, number>,
    training: { ...training, prs, top_lifts: topLifts(allSets, period.start, period.end, bw) },
    nutrition: { ...nutrition, logging_quality_pct: loggingQuality(items), days_in_period: n },
    body: {
      weight_trend_start: round(
        trendAt(trend, addDays(period.start, -1)) ??
          trend.find((t) => t.local_date >= period.start)?.trend_kg ??
          null,
        1,
      ),
      weight_trend_end: round(bw, 1),
      rate_kg_wk: rate?.kg_wk ?? null,
      rate_pct_bw_wk: rate?.pct_wk ?? null,
      weigh_ins: weights.filter((w) => w.local_date >= period.start && w.local_date <= period.end).length,
      maintenance_estimate: maintenance,
    },
    activity: { ...steps, cardio_min: cardioMin },
    sleep,
    insights,
    comparisons: { vs_previous_period: cmp },
  };
  if (kind === 'daily') {
    const today = nutDays.find((d) => d.local_date === period.end);
    brief.today = {
      kcal: Math.round(today?.kcal ?? 0),
      protein_g: Math.round(today?.protein_g ?? 0),
      remaining_protein_g:
        goals.protein_g !== undefined
          ? Math.max(0, Math.round(goals.protein_g - (today?.protein_g ?? 0)))
          : null,
      trained:
        training.sessions > 0
          ? ((db
              .prepare(
                `SELECT group_concat(coalesce(r.name, 'treino'), ', ') FROM workout_sessions ws LEFT JOIN routines r ON r.id = ws.routine_id
                  WHERE ws.local_date = ? AND ws.deleted_at IS NULL`,
              )
              .pluck()
              .get(period.end) as string | null) ?? 'treino')
          : null,
      steps: health.find((h) => h.local_date === period.end)?.steps ?? null,
    };
  }
  return brief;
}

// ── dados dos gráficos (Fase 5b) ─────────────────────────────────────────────────────────────

export type ChartData = {
  weight?: { local_date: string; weight_kg: number; trend_kg: number }[];
  sets_by_muscle?: { muscle: string; sets: number }[];
  e1rm?: { local_date: string; exercise: string; e1rm: number }[];
};

/** Séries para os gráficos (REPORTS.md §7). Só inclui um gráfico se houver dados suficientes. */
export function buildChartData(db: Db, brief: ReportBrief): ChartData {
  const out: ChartData = {};
  const { start, end } = brief.period;
  if (brief.kind === 'weekly') {
    const from = addDays(end, -55);
    const weight = weightTrend(loadWeights(db, end)).filter((p) => p.local_date >= from);
    if (weight.length >= 3) out.weight = weight.map((p) => ({ ...p, trend_kg: round(p.trend_kg, 2)! }));
    const sets = Object.entries(brief.training.sets_by_muscle)
      .filter(([, v]) => (v ?? 0) > 0)
      .map(([m, v]) => ({ muscle: MUSCLE_PT[m] ?? m, sets: v! }));
    if (sets.length) out.sets_by_muscle = sets;
  }
  if (brief.kind === 'monthly') {
    const top = new Set(brief.training.top_lifts.map((l) => l.exercise));
    const weights = weightTrend(loadWeights(db, end));
    const hist = e1rmHistory(loadSets(db, start, end), trendAt(weights, end));
    const pts = [...hist.values()]
      .filter((h) => top.has(h.exercise))
      .flatMap((h) =>
        h.points.map((p) => ({ local_date: p.local_date, exercise: h.exercise, e1rm: round(p.e1rm, 1)! })),
      );
    if (pts.length >= 2) out.e1rm = pts;
  }
  return out;
}
