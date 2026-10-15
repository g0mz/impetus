import { describe, expect, it } from 'vitest';
import { DETECTORS, runDetectors, type InsightContext } from '../../src/domain/insights/detectors.ts';

/** Semana "boa": nenhum detector deve disparar. */
const base = (): InsightContext => ({
  goals: { kcal: 2400, protein_g: 140, steps: 8000, sleep_h: 7, weight_rate_kg_wk: -0.5 },
  prs: [],
  stagnant: [],
  setsByMuscle: { chest: 10, upper_back: 10 },
  musclesWithHistory: ['chest', 'upper_back'],
  pushPull: 1,
  workSets: 40,
  workSetsAvg4w: 42,
  nutrition: { complete_days: 7, protein_adherence_pct: 86, protein_avg: 145 },
  rateKgWk: -0.45,
  maintenance: 2700,
  previousMaintenance: 2650,
  bias: [],
  sleep: { avg_min: 450, regularity_min: 30, nights: 7 },
  sleepPerf: { insufficient_data: true, n: 3 },
  steps: { steps_avg: 9000, days_with_data: 7 },
  rhr: { elevated: false, avg_14d: 55, avg_28d: 55 },
  hcLastSync: '2026-10-14T10:00:00Z',
  now: '2026-10-14T12:00:00Z',
  periodDays: 7,
});

const fire = (name: string, patch: Partial<InsightContext>) => {
  const r = DETECTORS[name]!({ ...base(), ...patch });
  return r === null ? [] : Array.isArray(r) ? r : [r];
};

describe('detectores (§3)', () => {
  it('semana sem problemas: nada dispara', () => {
    expect(runDetectors(base())).toEqual([]);
  });

  it.each([
    ['pr_celebration', { prs: [{ exercise: 'Supino', best: '30kg×10' }] }, 'pr_celebration'],
    ['stagnation', { stagnant: [{ exercise: 'Remada', sessions: 6 }] }, 'stagnation:Remada'],
    ['volume_imbalance', { pushPull: 1.8 }, 'volume_imbalance:push_pull'],
    ['volume_imbalance', { musclesWithHistory: ['chest', 'upper_back', 'quads'] }, 'volume_imbalance:zero'],
    ['volume_drop', { workSets: 20 }, 'volume_drop'],
    [
      'protein_gap',
      { nutrition: { complete_days: 6, protein_adherence_pct: 33, protein_avg: 110 } },
      'protein_gap',
    ],
    ['weight_rate_off', { rateKgWk: 0.1 }, 'weight_rate_off'],
    ['maintenance_update', { previousMaintenance: 2400 }, 'maintenance_update'],
    [
      'logging_gaps',
      { nutrition: { complete_days: 2, protein_adherence_pct: 50, protein_avg: 140 } },
      'logging_gaps',
    ],
    ['photo_bias', { bias: [{ label: 'arroz', n: 4, median_ratio: 0.7 }] }, 'photo_bias:arroz'],
    ['sleep_short', { sleep: { avg_min: 360, regularity_min: 30, nights: 6 } }, 'sleep_short'],
    [
      'sleep_performance_link',
      { sleepPerf: { insufficient_data: false, n: 10, diff_pct: -5, rho: 0.4 } },
      'sleep_performance_link',
    ],
    ['steps_below', { steps: { steps_avg: 5000, days_with_data: 7 } }, 'steps_below'],
    ['rhr_elevated', { rhr: { elevated: true, avg_14d: 62, avg_28d: 56 } }, 'rhr_elevated'],
    ['hc_stale', { hcLastSync: '2026-10-11T00:00:00Z' }, 'hc_stale'],
  ] as [string, Partial<InsightContext>, string][])('%s dispara (%s)', (name, patch, id) => {
    expect(fire(name, patch).map((i) => i.id)).toContain(id);
  });

  it('não disparam perto do limite', () => {
    expect(fire('weight_rate_off', { rateKgWk: -0.3 })).toEqual([]); // |Δ| = 0,2 ≤ 0,25
    expect(fire('volume_drop', { workSets: 30 })).toEqual([]); // 30 ≥ 0,7 × 42
    expect(
      fire('protein_gap', { nutrition: { complete_days: 3, protein_adherence_pct: 0, protein_avg: 50 } }),
    ).toEqual([]); // n < 4
    expect(fire('sleep_short', { sleep: { avg_min: 300, regularity_min: 30, nights: 2 } })).toEqual([]); // < 3 noites
    expect(fire('sleep_performance_link', { sleepPerf: { insufficient_data: true, n: 7 } })).toEqual([]);
  });

  it('top 6 por score, celebrações e sistema à parte', () => {
    const all = runDetectors({
      ...base(),
      prs: [{ exercise: 'Supino', best: '30kg×10' }],
      hcLastSync: '2026-10-10T00:00:00Z',
      stagnant: ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((exercise) => ({ exercise, sessions: 6 })),
      rateKgWk: 0.5,
    });
    expect(all.slice(0, 2).map((i) => i.id)).toEqual(['pr_celebration', 'hc_stale']);
    const rest = all.slice(2);
    expect(rest).toHaveLength(6);
    expect(rest.map((i) => i.score)).toEqual([...rest.map((i) => i.score)].sort((a, b) => b - a));
  });
});
