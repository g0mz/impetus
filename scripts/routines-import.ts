import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { runCli } from '../src/cli.ts';
import { REPO_ROOT, loadConfig } from '../src/config.ts';
import { openDb } from '../src/db/index.ts';
import { migrate } from '../src/db/migrate.ts';
import { importRoutines, type RoutinesSpec } from '../src/ops/routines-import.ts';
import { nowUtcIso } from '../src/time.ts';
import { buildRegistry } from '../src/tools/index.ts';

// npm run routines:import [arquivo.yaml] — padrão: seeds/routines.yaml
await runCli(() => {
  const config = loadConfig();
  const file = path.resolve(process.argv[2] ?? path.join(REPO_ROOT, 'seeds', 'routines.yaml'));
  const spec = parse(fs.readFileSync(file, 'utf8')) as RoutinesSpec;
  const db = openDb(config.dbPath);
  migrate(db);
  const r = importRoutines(
    db,
    buildRegistry(),
    { cutoffHour: config.DAY_CUTOFF_HOUR, timeZone: config.TZ, openSessionHours: config.OPEN_SESSION_HOURS },
    spec,
    nowUtcIso(),
  );
  for (const x of r.routines)
    console.log(`${x.replaced ? 'Atualizada' : 'Criada'}: ${x.name} (${x.exercises} exercícios)`);
  if (r.created.length) console.log(`Exercícios novos: ${r.created.join(', ')}`);
  if (r.aliases.length) console.log(`Apelidos: ${r.aliases.join('; ')}`);
  console.log('Para desfazer: /desfazer no chat (é o último turno).');
  db.close();
});
