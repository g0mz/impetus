import { describe, expect, it } from 'vitest';
import { fmtKg, setsCompact } from '../../src/domain/training/format.ts';
import { bestE1rm, effectiveWeight, epley, type SetLike } from '../../src/domain/training/load.ts';
import { isStagnant, nextTarget } from '../../src/domain/training/progression.ts';
import { detectPrs, vsLast } from '../../src/domain/training/prs.ts';
import { isSessionOpen } from '../../src/domain/training/types.ts';

const w = (
  weight_kg: number | null,
  reps: number | null,
  set_type: SetLike['set_type'] = 'work',
  rpe?: number,
): SetLike => ({
  weight_kg,
  reps,
  set_type,
  ...(rpe !== undefined ? { rpe } : {}),
});

describe('carga e e1RM', () => {
  it('peso efetivo por tipo de carga', () => {
    expect(effectiveWeight(30, 'per_hand')).toBe(60);
    expect(effectiveWeight(60, 'total')).toBe(60);
    expect(effectiveWeight(10, 'bodyweight_plus', 75)).toBe(85);
    expect(effectiveWeight(null, 'bodyweight_plus', 75)).toBe(75);
    expect(effectiveWeight(10, 'bodyweight_plus', null)).toBeNull();
    expect(effectiveWeight(20, 'assisted', 75)).toBe(55);
  });

  it('Epley só com 1–12 reps e carga > 0', () => {
    expect(epley(100, 10)).toBeCloseTo(133.333, 3);
    expect(epley(100, 1)).toBeCloseTo(103.333, 3);
    expect(epley(100, 13)).toBeNull();
    expect(epley(0, 10)).toBeNull();
    expect(epley(null, 10)).toBeNull();
  });

  it('melhor e1RM só de séries work, com peso efetivo', () => {
    const sets = [w(20, 12, 'warmup'), w(30, 10), w(32, 8), w(30, 15, 'drop')];
    // per_hand: 64 × (1 + 8/30) = 81,07 > 60 × (1 + 10/30) = 80
    expect(bestE1rm(sets, 'per_hand')).toBeCloseTo(81.0667, 3);
    expect(bestE1rm([w(20, 12, 'warmup')], 'total')).toBeNull();
  });
});

describe('formatação', () => {
  it('fmtKg em pt-BR', () => {
    expect(fmtKg(30)).toBe('30');
    expect(fmtKg(32.5)).toBe('32,5');
    expect(fmtKg(62.25)).toBe('62,3');
  });

  it('sets_compact nos três formatos', () => {
    expect(setsCompact([w(30, 10), w(30, 10), w(30, 10)])).toBe('30kg 3×10');
    expect(setsCompact([w(30, 10), w(30, 10), w(30, 9)])).toBe('30kg 10/10/9');
    expect(setsCompact([w(30, 10), w(32, 8)])).toBe('30kg 10, 32kg 8');
    expect(setsCompact([w(30, 10), w(30, 10), w(30, 10), w(32, 10), w(32, 9), w(32, 8)])).toBe('30kg 3×10, 32kg 10/9/8');
    expect(setsCompact([w(20, 12, 'warmup'), w(30, 10), w(30, 10)])).toBe('aq 20kg 12 · 30kg 2×10');
    expect(setsCompact([w(null, 10), w(null, 8)])).toBe('10/8');
  });
});

describe('PRs e vs_last', () => {
  it('sem histórico não há PR', () => {
    expect(detectPrs([], [w(30, 10)], 'per_hand')).toEqual([]);
  });

  it('detecta carga, e1RM e reps na mesma carga', () => {
    const hist = [w(28, 10), w(28, 10), w(28, 9)];
    expect(detectPrs(hist, [w(30, 10)], 'per_hand')).toEqual(['weight', 'e1rm']);
    expect(detectPrs(hist, [w(28, 11)], 'per_hand')).toEqual(['e1rm', 'reps_at_weight']);
    expect(detectPrs(hist, [w(28, 10)], 'per_hand')).toEqual([]);
  });

  it('aquecimento não gera PR', () => {
    expect(detectPrs([w(28, 10)], [w(40, 5, 'warmup'), w(28, 10)], 'total')).toEqual([]);
  });

  it('vs_last pela maior carga e, se igual, pelas reps', () => {
    expect(vsLast([w(28, 10)], [w(30, 10)])).toBe('+2kg');
    expect(vsLast([w(62.5, 8)], [w(60, 8)])).toBe('-2,5kg');
    expect(vsLast([w(60, 8), w(60, 8)], [w(60, 8), w(60, 8)])).toBe('=');
    expect(vsLast([w(60, 8), w(60, 8)], [w(60, 8), w(60, 9)])).toBe('+1 rep');
    expect(vsLast([w(60, 8), w(60, 8)], [w(60, 7), w(60, 7)])).toBe('-2 reps');
    expect(vsLast([], [w(60, 8)])).toBeUndefined();
  });
});

describe('progressão dupla (REPORTS.md §2.4)', () => {
  const sess = (sets: SetLike[], bestE1rm: number | null = 100) => ({ sets, bestE1rm });

  it('first_time sem histórico', () => {
    expect(nextTarget({ sessions: [], loadKind: 'total' }).rule).toBe('first_time');
  });

  it('increase quando todas as séries chegam ao topo da faixa', () => {
    const t = nextTarget({
      sessions: [sess([w(60, 10), w(60, 10), w(60, 10)])],
      repMin: 6,
      repMax: 10,
      loadKind: 'total',
    });
    expect(t).toMatchObject({ rule: 'increase', last: '60kg 3×10', target: '62,5kg 3×6' });
  });

  it('increase respeita RPE > 9 (não sobe)', () => {
    const t = nextTarget({
      sessions: [sess([w(60, 10, 'work', 10), w(60, 10)])],
      repMax: 10,
      loadKind: 'total',
    });
    expect(t.rule).toBe('hold');
  });

  it('halter sobe 2 kg por mão por padrão; incremento do exercício tem prioridade', () => {
    const s = [sess([w(30, 12), w(30, 12), w(30, 12)])];
    expect(nextTarget({ sessions: s, loadKind: 'per_hand' }).target).toBe('32kg 3×8');
    expect(nextTarget({ sessions: s, loadKind: 'per_hand', incrementKg: 1 }).target).toBe('31kg 3×8');
  });

  it('hold: +1 rep na série mais fraca (exemplo do SPEC)', () => {
    const t = nextTarget({
      sessions: [sess([w(28, 10), w(28, 10), w(28, 9)])],
      repMin: 8,
      repMax: 12,
      loadKind: 'per_hand',
    });
    expect(t).toMatchObject({ rule: 'hold', last: '28kg 10/10/9', target: '28kg 3×10' });
  });

  it('deload com queda de e1RM > 5% em 2 sessões seguidas', () => {
    const t = nextTarget({
      sessions: [sess([w(50, 8), w(50, 8)], 90), sess([w(55, 8)], 96), sess([w(60, 8)], 102)],
      loadKind: 'total',
    });
    expect(t).toMatchObject({ rule: 'deload', target: '45kg 2×8' });
  });

  it('estagnação: nenhuma das 4 últimas supera o melhor anterior', () => {
    expect(isStagnant([100, 101, 99, 100, 102])).toBe(true);
    expect(isStagnant([103, 101, 99, 100, 102])).toBe(false);
    expect(isStagnant([100, 100, 100, 100])).toBe(false); // menos de 5 sessões
  });
});

describe('sessão aberta', () => {
  it('menos de 3 h desde a última atividade', () => {
    expect(isSessionOpen('2026-10-13T21:10:00Z', '2026-10-13T23:00:00Z', 3)).toBe(true);
    expect(isSessionOpen('2026-10-13T20:00:00Z', '2026-10-13T23:00:00Z', 3)).toBe(false);
    expect(isSessionOpen(null, '2026-10-13T23:00:00Z', 3)).toBe(false);
  });
});
