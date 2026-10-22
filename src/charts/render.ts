import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Resvg } from '@resvg/resvg-js';
import * as vega from 'vega';
import { compile, type TopLevelSpec } from 'vega-lite';

/** Hex dos tokens web → variável CSS. Permite modo escuro sem re-renderizar o gráfico. */
export const WEB_HEX_TO_TOKEN: Record<string, string> = {
  '#fbfaf7': '--papel',
  '#16181b': '--tinta',
  '#1f3a5f': '--dado',
  '#c3d1b4': '--meta',
  '#b4532a': '--fora',
  '#8a8f98': '--fraca',
};

/**
 * `var()` resolve dentro de `style`, mas não em atributo de apresentação (`fill="var(--x)"` é
 * inválido). Daí o passo: atributo vira declaração em `style`, e o resto é substituição direta.
 */
export function tokenizeSvg(svg: string): string {
  let out = svg.replace(/(fill|stroke)="(#[0-9a-fA-F]{6})"/g, (m, prop: string, hex: string) => {
    const token = WEB_HEX_TO_TOKEN[hex.toLowerCase()];
    return token ? `style="${prop}:var(${token})"` : m;
  });
  for (const [hex, token] of Object.entries(WEB_HEX_TO_TOKEN)) {
    out = out.replace(new RegExp(hex, 'gi'), `var(${token})`);
  }
  return out;
}

/** Vega-Lite → SVG (vega, sem canvas), tokenizado para o dashboard servir inline. */
export async function renderChartSvg(spec: TopLevelSpec): Promise<string> {
  const view = new vega.View(vega.parse(compile(spec).spec), { renderer: 'none' });
  const svg = await view.toSVG();
  view.finalize();
  return tokenizeSvg(svg);
}

/** Vega-Lite → SVG (vega, sem canvas) → PNG 1080 px (resvg). Devolve o caminho do PNG salvo. */
export async function renderChart(spec: TopLevelSpec, outDir: string): Promise<string> {
  const view = new vega.View(vega.parse(compile(spec).spec), { renderer: 'none' });
  const svg = await view.toSVG();
  view.finalize();
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: 1080 }, font: { loadSystemFonts: true } })
    .render()
    .asPng();
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${randomUUID()}.png`);
  fs.writeFileSync(file, png);
  return file;
}
