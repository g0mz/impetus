import { runCli } from '../src/cli.ts';
import { loadConfig } from '../src/config.ts';
import { openDb } from '../src/db/index.ts';
import { migrate } from '../src/db/migrate.ts';
import { runSeeds } from '../src/seeds/index.ts';

await runCli(() => {
  const config = loadConfig();
  const db = openDb(config.dbPath);
  migrate(db);
  const r = runSeeds(db);
  console.log(`TACO: ${r.taco.inserted} alimentos (${r.taco.skipped.length} ignorados)`);
  for (const s of r.taco.skipped) console.log(`  - ignorado ${s.id} ${s.name}: ${s.reason}`);
  console.log(
    `Exercícios: ${r.exercises.imported} do free-exercise-db (${r.exercises.translated} em PT-BR), ` +
      `${r.exercises.custom} custom, ${r.exercises.aliases} apelidos novos`,
  );
  console.log(`Medidas caseiras (IBGE): ${r.portions}`);
  db.close();
});
