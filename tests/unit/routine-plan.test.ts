import { describe, expect, it } from 'vitest';
import { changedLoad, plannedSets, savedReps } from '../../src/domain/training/routine-plan.ts';

const p = (o: Partial<Parameters<typeof plannedSets>[0]> = {}) => ({
  target_sets: 3,
  rep_min: 8,
  rep_max: 12,
  weight_kg: 30,
  reps: 10,
  ...o,
});

describe('treino salvo da rotina (D-034)', () => {
  it('monta as séries com carga e reps salvas', () => {
    expect(plannedSets(p(), 'per_hand')).toEqual({
      ok: true,
      sets: [
        { weight_kg: 30, reps: 10, set_type: 'work' },
        { weight_kg: 30, reps: 10, set_type: 'work' },
        { weight_kg: 30, reps: 10, set_type: 'work' },
      ],
    });
  });

  it('ajustes do dia substituem só o campo citado', () => {
    const r = plannedSets(p(), 'total', { weight_kg: 32, sets: 2 });
    expect(r).toEqual({
      ok: true,
      sets: [
        { weight_kg: 32, reps: 10, set_type: 'work' },
        { weight_kg: 32, reps: 10, set_type: 'work' },
      ],
    });
  });

  it('sem reps salvas usa o menor valor da faixa', () => {
    expect(savedReps(p({ reps: null }))).toBe(8);
    expect(savedReps(p({ reps: null, rep_min: null }))).toBe(12);
    expect(savedReps(p({ reps: null, rep_min: null, rep_max: null }))).toBeNull();
  });

  it('diz o que falta; carga vazia só vale para peso corporal', () => {
    expect(plannedSets(p({ weight_kg: null, target_sets: null }), 'total')).toEqual({
      ok: false,
      missing: ['sets', 'weight'],
    });
    const bw = plannedSets(p({ weight_kg: null, target_sets: 2 }), 'bodyweight_plus');
    expect(bw).toEqual({
      ok: true,
      sets: [
        { reps: 10, set_type: 'work' },
        { reps: 10, set_type: 'work' },
      ],
    });
  });

  it('carga nova = maior carga de trabalho, só quando muda', () => {
    const s = (weight_kg: number | null, set_type: 'work' | 'warmup' = 'work') => ({
      weight_kg,
      reps: 10,
      set_type,
    });
    expect(changedLoad(30, [s(30), s(30)])).toBeNull();
    expect(changedLoad(30, [s(20, 'warmup'), s(32), s(30)])).toBe(32);
    expect(changedLoad(30, [s(27.5), s(27.5)])).toBe(27.5);
    expect(changedLoad(null, [s(40)])).toBe(40);
    expect(changedLoad(null, [s(null)])).toBeNull();
  });
});
