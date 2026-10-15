import { describe, expect, it } from 'vitest';
import { sleepStats, stepsStats, type HealthDay } from '../../src/domain/metrics/activity.ts';
import { maintenanceEstimate, weeklyRate, weightTrend } from '../../src/domain/metrics/body.ts';
import { loggingQuality, nutritionSummary } from '../../src/domain/metrics/nutrition.ts';
import { balance, setsByMuscle, tonnage, type TrainingSet } from '../../src/domain/metrics/training.ts';

const set = (o: Partial<TrainingSet>): TrainingSet => ({
  session_id: 1,
  local_date: '2026-10-12',
  started_at: '2026-10-12T21:00:00Z',
  exercise_id: 1,
  exercise: 'Supino inclinado com halteres',
  load_kind: 'per_hand',
  is_compound: true,
  primary: ['chest'],
  secondary: ['triceps'],
  weight_kg: 20,
  reps: 10,
  rpe: null,
  set_type: 'work',
  ...o,
});

describe('corpo (§2.3)', () => {
  it('tendência EMA α=0,1', () => {
    const t = weightTrend([
      { local_date: '2026-10-03', weight_kg: 82 },
      { local_date: '2026-10-01', weight_kg: 80 },
      { local_date: '2026-10-02', weight_kg: 81 },
    ]);
    expect(t.map((p) => Number(p.trend_kg.toFixed(2)))).toEqual([80, 80.1, 80.29]);
  });

  it('taxa semanal exige ≥ 8 pesagens', () => {
    const pts = Array.from({ length: 8 }, (_, i) => ({
      local_date: `2026-10-0${i + 1}`,
      weight_kg: 0,
      trend_kg: 80 - 0.1 * i,
    }));
    expect(weeklyRate(pts, '2026-10-08')).toEqual({ kg_wk: -0.7, pct_wk: -0.88, n: 8 });
    expect(weeklyRate(pts.slice(1), '2026-10-08')).toBeNull();
  });

  it('manutenção estimada: kcal média − Δtendência × 7700 / dias', () => {
    const base = {
      days: 28,
      completeDaysKcal: Array(28).fill(2500),
      trendStart: 80,
      trendEnd: 79,
      weighIns: 10,
    };
    expect(maintenanceEstimate(base)).toBe(2775);
    expect(maintenanceEstimate({ ...base, weighIns: 7 })).toBeNull();
    expect(maintenanceEstimate({ ...base, completeDaysKcal: Array(20).fill(2500) })).toBeNull();
  });
});

describe('nutrição (§2.5)', () => {
  it('médias só de dias completos e aderência à proteína', () => {
    const d = (local_date: string, meals: number, kcal: number, protein_g: number) => ({
      local_date,
      meals,
      kcal,
      protein_g,
      carbs_g: 0,
      fat_g: 0,
      fiber_g: 0,
    });
    const s = nutritionSummary(
      [d('2026-10-12', 3, 2000, 150), d('2026-10-13', 3, 2200, 120), d('2026-10-14', 1, 500, 30)],
      { kcal: 2400, protein_g: 140 },
      75,
    );
    expect(s).toEqual({
      days_logged: 3,
      complete_days: 2,
      kcal_avg: 2100,
      protein_avg: 135,
      protein_g_per_kg: 1.8,
      protein_days_hit: 1,
      protein_adherence_pct: 50,
    });
  });

  it('qualidade do registro', () => {
    expect(
      loggingQuality([
        { origin: 'user_stated', kcal: 300 },
        { origin: 'photo_estimate', kcal: 700 },
      ]),
    ).toBe(30);
    expect(loggingQuality([])).toBeNull();
  });
});

describe('atividade e sono (§2.6)', () => {
  const h = (o: Partial<HealthDay>): HealthDay => ({
    local_date: '2026-10-12',
    steps: null,
    sleep_minutes: null,
    sleep_start: null,
    sleep_end: null,
    resting_hr: null,
    ...o,
  });
  it('passos', () => {
    expect(stepsStats([h({ steps: 8000 }), h({ steps: 10000 }), h({ steps: 12000 }), h({})], 10000)).toEqual({
      days_with_data: 3,
      steps_avg: 10000,
      steps_median: 10000,
      steps_days_hit: 2,
    });
  });
  it('sono: média, regularidade (DP do ponto médio) e noites abaixo da meta', () => {
    const s = sleepStats(
      [
        h({ sleep_minutes: 420, sleep_start: '2026-10-10T02:00:00Z', sleep_end: '2026-10-10T09:00:00Z' }),
        h({ sleep_minutes: 480, sleep_start: '2026-10-11T02:00:00Z', sleep_end: '2026-10-11T10:00:00Z' }),
      ],
      7.5,
    );
    expect(s).toEqual({ nights: 2, avg_min: 450, regularity_min: 21, days_below_goal: 1 });
  });
});

describe('treino (§2.2)', () => {
  const sets = [
    set({ set_type: 'warmup', weight_kg: 10 }),
    set({}),
    set({}),
    set({}),
    ...[1, 2, 3].map(() =>
      set({
        exercise_id: 2,
        exercise: 'Remada',
        load_kind: 'total',
        weight_kg: 60,
        reps: 8,
        primary: ['upper_back'],
        secondary: [],
      }),
    ),
  ];
  it('séries duras por músculo (secundário 0,5; sem aquecimento) e equilíbrio', () => {
    const m = setsByMuscle(sets);
    expect(m).toEqual({ chest: 3, triceps: 1.5, upper_back: 3 });
    expect(balance(m).push_pull).toBe(1.5);
  });
  it('tonelagem: per_hand ×2, sem aquecimento', () => {
    expect(tonnage(sets, 80)).toBe(3 * 40 * 10 + 3 * 60 * 8);
  });
});
