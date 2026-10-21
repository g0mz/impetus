// Exporta o último payload REAL do HC Webhook (health_raw) como fixture anonimizado:
// remove metadados de dispositivo/origem e desloca todas as datas para que o primeiro dia seja 2026-01-05.
//   npm run hc:fixture                      → tests/fixtures/hc_real_anon.json
import fs from 'node:fs';
import path from 'node:path';
import { runCli } from '../src/cli.ts';
import { REPO_ROOT, loadConfig } from '../src/config.ts';
import { openDb } from '../src/db/index.ts';

const BASE = Date.parse('2026-01-05T00:00:00Z');
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function collectTimes(v: unknown, out: number[]): void {
  if (typeof v === 'string' && ISO.test(v)) out.push(Date.parse(v));
  else if (Array.isArray(v)) v.forEach((x) => collectTimes(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => collectTimes(x, out));
}

function transform(v: unknown, shift: number): unknown {
  if (typeof v === 'string' && ISO.test(v)) return new Date(Date.parse(v) + shift).toISOString();
  if (Array.isArray(v)) return v.map((x) => transform(x, shift));
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v)
        .filter(([k]) => !['metadata', 'device', 'data_origin', 'client_record_id', 'id'].includes(k))
        .map(([k, x]) => [k, transform(x, shift)]),
    );
  }
  return v;
}

await runCli(() => {
  const config = loadConfig();
  const db = openDb(config.dbPath, { readonly: true });
  const row = db.prepare('SELECT id, payload FROM health_raw ORDER BY id DESC LIMIT 1').get() as
    { id: number; payload: string } | undefined;
  if (!row) {
    console.error('Nenhum payload em health_raw. Configure o HC Webhook e sincronize primeiro.');
    process.exitCode = 1;
    return;
  }
  const payload = JSON.parse(row.payload) as unknown;
  const times: number[] = [];
  collectTimes(payload, times);
  const first = Math.min(...times);
  const dayStart = Date.UTC(
    new Date(first).getUTCFullYear(),
    new Date(first).getUTCMonth(),
    new Date(first).getUTCDate(),
  );
  const out = transform(payload, BASE - dayStart) as Record<string, unknown>;
  const file = path.join(REPO_ROOT, 'tests', 'fixtures', 'hc_real_anon.json');
  fs.writeFileSync(
    file,
    `${JSON.stringify({ _comment: `real anonimizado (health_raw ${row.id})`, ...out }, null, 2)}\n`,
  );
  console.log(
    `Fixture salvo em ${file}. Tipos: ${Object.keys(out)
      .filter((k) => Array.isArray(out[k]))
      .join(', ')}`,
  );
  db.close();
});
