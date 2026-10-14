import { startApp } from './app.ts';
import { runCli } from './cli.ts';
import { loadConfig } from './config.ts';
import { createLogger } from './logger.ts';

await runCli(async () => {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL);
  const app = await startApp(config, logger);
  const shutdown = async () => {
    logger.info('encerrando');
    await app.stop();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  await app.done;
  await app.stop();
});
