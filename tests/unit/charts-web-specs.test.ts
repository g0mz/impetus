import { describe, expect, it } from 'vitest';
import {
  e1rmWebSpec,
  kcalProteinSpec,
  setsByMuscleWebSpec,
  sleepSpec,
  stepsSpec,
  weightWebSpec,
} from '../../src/charts/specs.ts';

const DAYS = [
  { local_date: '2026-10-15', kcal: 2180, protein_g: 142 },
  { local_date: '2026-10-16', kcal: 2450, protein_g: 171 },
];

describe('specs web', () => {
  it('kcal e proteína desenham a faixa de meta quando há meta', () => {
    const spec = kcalProteinSpec(DAYS, { kcal: 2300, protein_g: 160 });
    expect(JSON.stringify(spec)).toContain('#C3D1B4');
  });

  it('sem meta, não desenha faixa', () => {
    expect(JSON.stringify(kcalProteinSpec(DAYS, {}))).not.toContain('#C3D1B4');
  });

  it('usam a largura web, não a do relatório', () => {
    for (const spec of [
      stepsSpec([{ local_date: '2026-10-16', steps: 11267 }], 8000),
      sleepSpec([{ local_date: '2026-10-16', hours: 7.5 }], 8),
      kcalProteinSpec(DAYS, {}),
    ]) {
      expect((spec as { width: number }).width).toBe(360);
      expect((spec as { background: string }).background).toBe('#FBFAF7');
    }
  });

  it('série principal usa o token --dado', () => {
    expect(JSON.stringify(stepsSpec([{ local_date: '2026-10-16', steps: 11267 }]))).toContain('#1F3A5F');
  });

  it('datas viram meio-dia local, para não cair no dia anterior', () => {
    expect(JSON.stringify(stepsSpec([{ local_date: '2026-10-16', steps: 1 }]))).toContain(
      '2026-10-16T12:00:00',
    );
  });
});

describe('specs web de treino e peso', () => {
  it('peso traz pontos e linha de tendência, na largura web', () => {
    const spec = weightWebSpec([{ local_date: '2026-10-16', weight_kg: 82.4, trend_kg: 82.6 }]);
    const json = JSON.stringify(spec);
    expect((spec as { width: number }).width).toBe(360);
    expect(json).toContain('weight_kg');
    expect(json).toContain('trend_kg');
  });

  it('peso desenha a faixa só com peso alvo', () => {
    expect(
      JSON.stringify(weightWebSpec([{ local_date: '2026-10-16', weight_kg: 82.4, trend_kg: 82.6 }])),
    ).not.toContain('#C3D1B4');
    expect(
      JSON.stringify(weightWebSpec([{ local_date: '2026-10-16', weight_kg: 82.4, trend_kg: 82.6 }], 80)),
    ).toContain('#C3D1B4');
  });

  it('volume cresce de altura com o número de grupos', () => {
    const poucos = setsByMuscleWebSpec([{ muscle: 'peito', sets: 14 }]) as { height: number };
    const muitos = setsByMuscleWebSpec(
      Array.from({ length: 10 }, (_, i) => ({ muscle: `m${i}`, sets: i })),
    ) as { height: number };
    expect(muitos.height).toBeGreaterThan(poucos.height);
  });

  it('e1RM usa escala sem zero, para a progressão ficar visível', () => {
    expect(JSON.stringify(e1rmWebSpec([{ local_date: '2026-10-16', e1rm: 92.5 }]))).toContain('"zero":false');
  });
});
