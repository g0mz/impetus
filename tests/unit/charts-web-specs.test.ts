import { describe, expect, it } from 'vitest';
import { kcalProteinSpec, sleepSpec, stepsSpec } from '../../src/charts/specs.ts';

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
