import { describe, expect, it } from 'vitest';
import { aggregateConfidence } from '../../src/domain/nutrition/confidence.ts';
import { itemMacros, portionTo100g, roundMacros, sumMacros } from '../../src/domain/nutrition/macros.ts';
import { inferMealType } from '../../src/domain/nutrition/meal-type.ts';
import { computePriors, detectBias, quantile } from '../../src/domain/nutrition/priors.ts';

const frango = { kcal_100g: 159, protein_100g: 32, carbs_100g: 0, fat_100g: 2.5, fiber_100g: null };
const arroz = { kcal_100g: 128, protein_100g: 2.5, carbs_100g: 28.1, fat_100g: 0.2, fiber_100g: 1.6 };

describe('macros (o LLM nunca soma)', () => {
  it('item = por 100 g × gramas ÷ 100; soma e arredondamento', () => {
    expect(roundMacros(itemMacros(frango, 150))).toEqual({
      kcal: 239,
      protein_g: 48,
      carbs_g: 0,
      fat_g: 4,
      fiber_g: null,
    });
    const t = sumMacros([itemMacros(frango, 150), itemMacros(arroz, 140)]);
    expect(t.kcal).toBeCloseTo(238.5 + 179.2, 6);
    expect(t.fiber_g).toBeCloseTo(2.24, 6);
  });

  it('porção do rótulo → por 100 g (1 scoop 30 g = 24 g prot)', () => {
    expect(portionTo100g({ grams: 30, kcal: 120, protein_g: 24, carbs_g: 3, fat_g: 1.5 })).toEqual({
      kcal_100g: 400,
      protein_100g: 80,
      carbs_100g: 10,
      fat_100g: 5,
      fiber_100g: null,
    });
  });
});

describe('confiança agregada (D-021)', () => {
  it('ponderada por kcal', () => {
    expect(
      aggregateConfidence([
        { kcal: 500, confidence: 'high' },
        { kcal: 100, confidence: 'low' },
      ]),
    ).toBe('high'); // 0,83
    expect(
      aggregateConfidence([
        { kcal: 300, confidence: 'high' },
        { kcal: 300, confidence: 'low' },
      ]),
    ).toBe('medium'); // 0,5
    expect(
      aggregateConfidence([
        { kcal: 100, confidence: 'medium' },
        { kcal: 400, confidence: 'low' },
      ]),
    ).toBe('low'); // 0,1
    expect(aggregateConfidence([{ kcal: 0, confidence: 'high' }])).toBe('high');
    expect(aggregateConfidence([])).toBe('low');
  });
});

describe('priors pessoais e viés', () => {
  const now = '2026-10-13T20:00:00Z';
  it('quantis com interpolação', () => {
    expect(quantile([100, 120, 140, 160], 0.5)).toBe(130);
    expect(quantile([100, 120, 140, 160], 0.25)).toBe(115);
  });

  it('mediana/p25/p75 em múltiplos de 5, janela de 120 dias, n ≥ 2', () => {
    const rows = [
      { label_norm: 'arroz', grams: 100, created_at: '2026-10-01T12:00:00Z' },
      { label_norm: 'arroz', grams: 120, created_at: '2026-10-05T12:00:00Z' },
      { label_norm: 'arroz', grams: 160, created_at: '2026-10-10T12:00:00Z' },
      { label_norm: 'arroz', grams: 500, created_at: '2026-01-01T12:00:00Z' }, // fora da janela
      { label_norm: 'feijao', grams: 140, created_at: '2026-10-10T12:00:00Z' }, // n = 1
    ];
    expect(computePriors(rows, now)).toEqual([
      { label: 'arroz', n: 3, median_g: 120, p25_g: 110, p75_g: 140, last_seen: '2026-10-10T12:00:00Z' },
    ]);
  });

  it('viés: > 60% das correções para baixo em 14 dias (n ≥ 3)', () => {
    const c = (o: number, n: number, d: string) => ({
      label_norm: 'arroz',
      old_grams: o,
      new_grams: n,
      created_at: d,
    });
    const rows = [
      c(150, 120, '2026-10-02T12:00:00Z'),
      c(200, 160, '2026-10-05T12:00:00Z'),
      c(100, 80, '2026-10-12T12:00:00Z'),
      c(100, 120, '2026-10-12T13:00:00Z'),
    ];
    expect(detectBias(rows, now)).toEqual([{ label: 'arroz', n: 4, down_share: 0.75, median_ratio: 0.8 }]);
    expect(detectBias(rows.slice(0, 2), now)).toEqual([]);
  });
});

describe('tipo de refeição pelo horário', () => {
  it('faixas do TASKS', () => {
    expect(inferMealType(7, 0)).toBe('cafe');
    expect(inferMealType(10, 30)).toBe('almoco');
    expect(inferMealType(15, 0)).toBe('lanche');
    expect(inferMealType(18, 30)).toBe('jantar');
    expect(inferMealType(22, 30)).toBe('ceia');
    expect(inferMealType(1, 0)).toBe('ceia');
  });
});
