import fs from 'node:fs';
import path from 'node:path';
import { createClaudeCliBrain } from './brain/claude-cli.ts';
import { noneBrain, type Brain } from './brain/types.ts';
import { createTerminalChannel } from './channels/terminal.ts';
import { createWhatsAppChannel } from './channels/whatsapp-baileys.ts';
import type { Channel } from './channels/types.ts';
import { REPO_ROOT, type Config } from './config.ts';
import { openDb } from './db/index.ts';
import { migrate } from './db/migrate.ts';
import { countExercises } from './db/repos/exercises.ts';
import { createInbox } from './gateway/inbox.ts';
import { createIngestApp, startIngestServer } from './ingest/http.ts';
import { createOwnerGuard } from './gateway/owner-pairing.ts';
import { createTurnRunner } from './gateway/turn-runner.ts';
import type { Logger } from './logger.ts';
import { MCP_SERVER_NAME, createTokenStore, startMcpServer } from './mcp/server.ts';
import { runSeeds } from './seeds/index.ts';
import { buildRegistry } from './tools/index.ts';
import type { ToolSettings } from './tools/registry.ts';

export const SYSTEM_PROMPT_FILE = path.join(REPO_ROOT, 'runtime', 'prompts', 'system.md');

export function isolationArgs(mode: Config['BRAIN_ISOLATION']): string[] {
  if (mode === 'setting-sources') return ['--setting-sources', ''];
  if (mode === 'safe-mode') return ['--safe-mode'];
  return [];
}

export function createBrain(config: Config, mcpUrl: string, logger: Logger): Brain {
  switch (config.BRAIN_PROVIDER) {
    case 'none':
      return noneBrain;
    case 'claude-cli':
      return createClaudeCliBrain({
        bin: config.CLAUDE_BIN,
        cwd: config.BRAIN_DIR,
        systemPromptFile: SYSTEM_PROMPT_FILE,
        mcpUrl,
        mcpServerName: MCP_SERVER_NAME,
        mediaDir: config.mediaDir,
        maxTurns: config.BRAIN_MAX_TURNS,
        timeoutMs: config.BRAIN_TIMEOUT_MS,
        isolationArgs: isolationArgs(config.BRAIN_ISOLATION),
        fallbackModels: { [config.MODEL_FAST]: config.MODEL_VISION },
        logger: logger.child({ mod: 'brain' }),
      });
    default:
      throw new Error(`BRAIN_PROVIDER=${config.BRAIN_PROVIDER} ainda não implementado (Fase 7)`);
  }
}

/** Sobe banco, MCP, cérebro e canal. Devolve uma função de parada. */
export async function startApp(config: Config, logger: Logger, channelOverride?: Channel) {
  const db = openDb(config.dbPath);
  migrate(db);
  if (countExercises(db) === 0) {
    const r = runSeeds(db);
    logger.info(
      { foods: r.taco.inserted, exercises: r.exercises.imported, portions: r.portions },
      'seeds aplicados (banco vazio)',
    );
  }
  fs.mkdirSync(config.mediaDir, { recursive: true });

  const settings: ToolSettings = {
    cutoffHour: config.DAY_CUTOFF_HOUR,
    timeZone: config.TZ,
    openSessionHours: config.OPEN_SESSION_HOURS,
  };
  const registry = buildRegistry();
  const tokens = createTokenStore();
  const mcp = await startMcpServer(
    { db, registry, tokens, settings, logger: logger.child({ mod: 'mcp' }) },
    config.MCP_PORT,
  );
  const brain = createBrain(config, mcp.url, logger);
  const ingestApp = createIngestApp({
    db,
    apiKey: config.INGEST_API_KEY,
    settings,
    logger: logger.child({ mod: 'ingest' }),
  });
  const ingest = await startIngestServer(ingestApp, config.INGEST_PORT);

  const owner = createOwnerGuard(db, logger.child({ mod: 'owner' }));
  let channel: Channel;
  if (channelOverride) channel = channelOverride;
  else if (config.CHANNEL === 'terminal') channel = createTerminalChannel({ mediaDir: config.mediaDir });
  else if (config.CHANNEL === 'whatsapp')
    channel = createWhatsAppChannel({
      authDir: config.waAuthDir,
      mediaDir: config.mediaDir,
      sendMinIntervalMs: config.WA_SEND_MIN_INTERVAL_MS,
      logger: logger.child({ mod: 'whatsapp' }),
      defaultTo: () => owner.defaultChat(),
    });
  else throw new Error(`CHANNEL=${config.CHANNEL} ainda não implementado (Fase 7)`);
  const isTerminal = channel.name === 'terminal';

  const runTurn = createTurnRunner({
    db,
    brain,
    tokens,
    settings,
    models: { fast: config.MODEL_FAST, vision: config.MODEL_VISION, report: config.MODEL_REPORT },
    recentTurns: config.CONTEXT_RECENT_TURNS,
    retryDelayMs: config.BRAIN_RETRY_DELAY_MS,
    logger: logger.child({ mod: 'turn' }),
  });
  const handle = createInbox({
    db,
    channel,
    registry,
    settings,
    runTurn,
    logger: logger.child({ mod: 'inbox' }),
    ...(isTerminal
      ? {}
      : { owner, debounceMs: config.DEBOUNCE_MS, debounceImageMs: config.DEBOUNCE_IMAGE_MS }),
    ...(config.CLAUDE_TOKEN_EXPIRES_AT ? { claudeTokenExpiresAt: config.CLAUDE_TOKEN_EXPIRES_AT } : {}),
  });
  logger.info(
    { channel: channel.name, brain: brain.name, mcp: mcp.url, ingest: ingest.url },
    'impetus iniciado',
  );

  const done = channel.start(async (m) => {
    try {
      await handle(m);
    } catch (e) {
      logger.error({ err: e }, 'falha ao processar mensagem');
    }
  });

  return {
    db,
    done,
    async stop() {
      await channel.stop();
      await handle.drain();
      await mcp.close();
      await ingest.close();
      db.close();
    },
  };
}
