import { describe, expect, it } from 'vitest';
import type { TopLevelSpec } from 'vega-lite';
import { WEB_HEX_TO_TOKEN, renderChartSvg, tokenizeSvg } from '../../src/charts/render.ts';

/** Spec mínimo com as cores do sistema, para não depender dos specs do dashboard. */
const barSpec = (rows: { local_date: string; steps: number }[]): TopLevelSpec => ({
  background: '#FBFAF7',
  width: 360,
  height: 140,
  data: { values: rows.map((r) => ({ ...r, local_date: `${r.local_date}T12:00:00` })) },
  mark: { type: 'bar', fill: '#1F3A5F' },
  encoding: {
    x: { field: 'local_date', type: 'temporal' },
    y: { field: 'steps', type: 'quantitative' },
  },
});

describe('tokenizeSvg', () => {
  it('troca hex conhecido por var() dentro de style', () => {
    const out = tokenizeSvg('<rect fill="#1F3A5F"/><path style="stroke: #b4532a;"/>');
    expect(out).toContain('style="fill:var(--dado)"');
    expect(out).toMatch(/stroke:\s*var\(--fora\)/);
    expect(out).not.toMatch(/#1f3a5f/i);
    expect(out).not.toMatch(/#b4532a/i);
  });

  it('deixa hex de fora do sistema intacto', () => {
    expect(tokenizeSvg('<rect fill="#123456"/>')).toContain('fill="#123456"');
  });
});

describe('renderChartSvg', () => {
  it('devolve SVG sem nenhum hex do sistema de cor', async () => {
    const svg = await renderChartSvg(
      barSpec([
        { local_date: '2026-10-15', steps: 9283 },
        { local_date: '2026-10-16', steps: 11267 },
      ]),
    );
    expect(svg).toContain('<svg');
    for (const hex of Object.keys(WEB_HEX_TO_TOKEN)) {
      expect(svg.toLowerCase()).not.toContain(hex.toLowerCase());
    }
    expect(svg).toContain('var(--dado)');
  });
});
