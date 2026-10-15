import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Resvg } from '@resvg/resvg-js';
import * as vega from 'vega';
import { compile, type TopLevelSpec } from 'vega-lite';

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
