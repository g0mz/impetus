import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderChart } from '../../src/charts/render.ts';
import { e1rmSpec, setsByMuscleSpec, weightTrendSpec } from '../../src/charts/specs.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'charts-'));
const pngWidth = (file: string) => fs.readFileSync(file).readUInt32BE(16);

describe('gráficos (Fase 5b)', () => {
  it('renderiza os três gráficos em PNG de 1080 px', async () => {
    const dir = tmp();
    const weight = Array.from({ length: 10 }, (_, i) => ({
      local_date: `2026-10-${String(i + 1).padStart(2, '0')}`,
      weight_kg: 80 - i * 0.1 + (i % 2 ? 0.3 : -0.2),
      trend_kg: 80 - i * 0.08,
    }));
    const files = [
      await renderChart(weightTrendSpec(weight), dir),
      await renderChart(
        setsByMuscleSpec([
          { muscle: 'peito', sets: 10 },
          { muscle: 'costas (meio)', sets: 12 },
        ]),
        dir,
      ),
      await renderChart(
        e1rmSpec([
          { local_date: '2026-09-01', exercise: 'Supino', e1rm: 90 },
          { local_date: '2026-09-15', exercise: 'Supino', e1rm: 93.5 },
        ]),
        dir,
      ),
    ];
    for (const f of files) {
      expect(fs.readFileSync(f).subarray(1, 4).toString()).toBe('PNG');
      expect(pngWidth(f)).toBe(1080);
    }
  }, 30_000);
});
