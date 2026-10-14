import { ConfigError } from './config.ts';

/** Executa um entrypoint; erro de configuração vira mensagem limpa e exit code 1. */
export async function runCli(main: () => void | Promise<void>): Promise<void> {
  try {
    await main();
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(e.message);
      process.exitCode = 1;
      return;
    }
    throw e;
  }
}
