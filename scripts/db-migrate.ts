import { runCli } from '../src/cli.ts';
import { loadConfig } from '../src/config.ts';
import { openDb } from '../src/db/index.ts';
import { migrate } from '../src/db/migrate.ts';

await runCli(() => {
  const config = loadConfig();
  const db = openDb(config.dbPath);
  const applied = migrate(db);
  console.log(applied.length ? `Migrations aplicadas: ${applied.join(', ')}` : 'Banco já está atualizado.');
  db.close();
});
