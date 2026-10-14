// REPL no terminal com o cérebro real (canal terminal). Logs vão para data/logs/chat.log.
import path from 'node:path';
import pino from 'pino';
import { startApp } from '../src/app.ts';
import { runCli } from '../src/cli.ts';
import { loadConfig } from '../src/config.ts';
import { createLogger } from '../src/logger.ts';

await runCli(async () => {
  const config = loadConfig({ ...process.env, CHANNEL: 'terminal' });
  const logFile = path.join(config.DATA_DIR, 'logs', 'chat.log');
  const logger = createLogger(config.LOG_LEVEL, pino.destination({ dest: logFile, mkdir: true, sync: true }));
  const app = await startApp(config, logger);
  await app.done;
  await app.stop();
});
