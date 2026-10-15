import type { TopLevelSpec } from 'vega-lite';

/** Tema escuro legível no celular (REPORTS.md §7): 1080 px de largura. */
const WIDTH = 1000;
const THEME: Pick<TopLevelSpec, 'background' | 'padding' | 'config'> = {
  background: '#111418',
  padding: 40,
  config: {
    font: 'DejaVu Sans, Arial, sans-serif',
    view: { stroke: null },
    locale: { number: { decimal: ',', thousands: '.', grouping: [3], currency: ['R$ ', ''] } },
    title: { color: '#f1f3f5', fontSize: 30, anchor: 'start', offset: 20 },
    axis: {
      labelColor: '#c9ced4',
      titleColor: '#c9ced4',
      gridColor: '#2a2f36',
      domainColor: '#3a4048',
      tickColor: '#3a4048',
      labelFontSize: 20,
      titleFontSize: 20,
      labelLimit: 400,
    },
    legend: { labelColor: '#c9ced4', titleColor: '#c9ced4', labelFontSize: 20, titleFontSize: 20 },
  },
};

/** Meio-dia local: datas 'YYYY-MM-DD' seriam lidas como meia-noite UTC e cairiam no dia anterior em -03:00. */
const noon = <T extends { local_date: string }>(xs: T[]) =>
  xs.map((x) => ({ ...x, local_date: `${x.local_date}T12:00:00` }));

export type WeightPoint = { local_date: string; weight_kg: number; trend_kg: number };

/** Tendência de peso (8 semanas): pesagens brutas como pontos, tendência como linha. */
export function weightTrendSpec(points: WeightPoint[]): TopLevelSpec {
  return {
    ...THEME,
    width: WIDTH,
    height: 500,
    title: 'Peso: tendência (linha) e pesagens (pontos)',
    data: { values: noon(points) },
    encoding: {
      x: { field: 'local_date', type: 'temporal', title: null, axis: { format: '%d/%m', labelAngle: 0 } },
    },
    layer: [
      {
        mark: { type: 'point', filled: true, size: 90, color: '#6c7682' },
        encoding: { y: { field: 'weight_kg', type: 'quantitative', scale: { zero: false }, title: 'kg' } },
      },
      {
        mark: { type: 'line', strokeWidth: 5, color: '#4dabf7' },
        encoding: { y: { field: 'trend_kg', type: 'quantitative', scale: { zero: false } } },
      },
    ],
  } as TopLevelSpec;
}

/** Séries duras por grupo muscular na semana (barras horizontais). */
export function setsByMuscleSpec(rows: { muscle: string; sets: number }[]): TopLevelSpec {
  return {
    ...THEME,
    width: WIDTH,
    height: Math.max(200, rows.length * 48),
    title: 'Séries por grupo muscular',
    data: { values: rows },
    mark: { type: 'bar', color: '#51cf66', cornerRadiusEnd: 4 },
    encoding: {
      y: { field: 'muscle', type: 'nominal', sort: '-x', title: null },
      x: { field: 'sets', type: 'quantitative', title: 'séries', axis: { format: 'd', tickMinStep: 1 } },
    },
  } as TopLevelSpec;
}

/** e1RM dos principais exercícios no mês (linhas). */
export function e1rmSpec(points: { local_date: string; exercise: string; e1rm: number }[]): TopLevelSpec {
  return {
    ...THEME,
    width: WIDTH,
    height: 550,
    title: 'e1RM estimado (kg)',
    data: { values: noon(points) },
    mark: { type: 'line', point: { filled: true, size: 80 }, strokeWidth: 4 },
    encoding: {
      x: { field: 'local_date', type: 'temporal', title: null, axis: { format: '%d/%m', labelAngle: 0 } },
      y: { field: 'e1rm', type: 'quantitative', scale: { zero: false }, title: 'kg' },
      color: { field: 'exercise', type: 'nominal', title: null, legend: { orient: 'bottom', columns: 1 } },
    },
  } as TopLevelSpec;
}
