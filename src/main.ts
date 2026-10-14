import { runCli } from './cli.ts';
import { loadConfig } from './config.ts';
import { openDb } from './db/index.ts';
import { migrate } from './db/migrate.ts';
import { createLogger } from './logger.ts';

// Fase 0: só valida a configuração e prepara o banco. Canal, MCP, ingest e scheduler
// entram nas fases seguintes (docs/TASKS.md).
await runCli(() => {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL);
  const db = openDb(config.dbPath);
  const applied = migrate(db);
  logger.info({ dbPath: config.dbPath, applied }, 'impetus: banco pronto (fase 0)');
  db.close();
});
