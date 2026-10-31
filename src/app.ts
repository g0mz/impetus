import fs from 'node:fs';
import path from 'node:path';
import { createClaudeCliBrain, runPlainPrompt } from './brain/claude-cli.ts';
import { noneBrain, type Brain, type PlainLlm } from './brain/types.ts';
import { createTelegramChannel } from './channels/telegram.ts';
import { createTerminalChannel } from './channels/terminal.ts';
import { createWhatsAppChannel } from './channels/whatsapp-baileys.ts';
import { waitChannelOpen, type Channel } from './channels/types.ts';
import { REPO_ROOT, type Config } from './config.ts';
import { openDb } from './db/index.ts';
import { migrate } from './db/migrate.ts';
import { countExercises } from './db/repos/exercises.ts';
import { getSetting } from './db/repos/settings.ts';
import { createInbox } from './gateway/inbox.ts';
import { createDashboardApp, startDashboardServer } from './dashboard/http.ts';
import { createIngestApp, startIngestServer } from './ingest/http.ts';
import { createOwnerGuard } from './gateway/owner-pairing.ts';
import { createTurnRunner } from './gateway/turn-runner.ts';
import type { Logger } from './logger.ts';
import type { ReportKind } from './reports/build.ts';
import { createWhisperCppTranscriber } from './media/transcribe.ts';
import { acquireInstanceLock } from './ops/lock.ts';
import { generateCheckin, sendCheckin } from './reports/checkin.ts';
import { generateReport } from './reports/service.ts';
import { buildJobs, startScheduler, type Notify } from './scheduler/jobs.ts';
import { nowUtcIso } from './time.ts';
import { MCP_SERVER_NAME, createTokenStore, startMcpServer } from './mcp/server.ts';
import { runSeeds } from './seeds/index.ts';
import { buildRegistry } from './tools/index.ts';
import type { ToolSettings } from './tools/registry.ts';

export const SYSTEM_PROMPT_FILE = path.join(REPO_ROOT, 'runtime', 'prompts', 'system.md');
export const EVIDENCE_DIR = path.join(REPO_ROOT, 'runtime', 'evidence');

export function isolationArgs(mode: Config['BRAIN_ISOLATION']): string[] {
  if (mode === 'setting-sources') return ['--setting-sources', ''];
  if (mode === 'safe-mode') return ['--safe-mode'];
  return [];
}

/** LLM sem tools do provider configurado (simulação de personas; Fase 8f). */
export function createPlainLlm(config: Config): PlainLlm {
  if (config.BRAIN_PROVIDER !== 'claude-cli')
    throw new Error(`simulação exige BRAIN_PROVIDER=claude-cli (atual: ${config.BRAIN_PROVIDER})`);
  return ({ system, prompt, model }) =>
    runPlainPrompt({
      bin: config.CLAUDE_BIN,
      cwd: config.BRAIN_DIR,
      model,
      system,
      prompt,
      timeoutMs: config.BRAIN_TIMEOUT_MS,
      isolationArgs: isolationArgs(config.BRAIN_ISOLATION),
    });
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
        evidenceDir: EVIDENCE_DIR,
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
  const releaseLock =
    !channelOverride && config.CHANNEL !== 'terminal'
      ? acquireInstanceLock(config.DATA_DIR)
      : () => undefined;
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
    ...(config.VAULT_DIR
      ? { vaultDir: config.VAULT_DIR, vaultMaxNotes: config.VAULT_ORGANIZE_MAX_NOTES }
      : {}),
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
  const dashboard = config.DASHBOARD
    ? await startDashboardServer(
        createDashboardApp({ db, settings, logger: logger.child({ mod: 'dashboard' }) }),
        config.DASHBOARD_PORT,
      )
    : undefined;

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
      mayHandle: owner.mayHandle,
    });
  else
    channel = createTelegramChannel({
      token: config.TELEGRAM_BOT_TOKEN!,
      mediaDir: config.mediaDir,
      logger: logger.child({ mod: 'telegram' }),
      defaultTo: () => owner.defaultChat(),
      mayHandle: owner.mayHandle,
    });
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
  const reportLogger = logger.child({ mod: 'report' });
  const report = (kind: ReportKind) =>
    generateReport({
      db,
      kind,
      now: nowUtcIso(),
      cutoffHour: config.DAY_CUTOFF_HOUR,
      timeZone: config.TZ,
      ...(brain.name === 'none' ? {} : { runTurn }),
      ...(config.REPORT_CHARTS ? { chartsDir: path.join(config.mediaDir, 'charts') } : {}),
      logger: reportLogger,
    });
  /** Check-in da manhã: gera, envia e grava a mensagem com o turno (aparece no <recent_turns>). */
  const checkin = async () => {
    const r = await generateCheckin({
      db,
      now: nowUtcIso(),
      settings,
      ...(brain.name === 'none' ? {} : { runTurn }),
      logger: reportLogger,
    });
    if (!r) return 'nada a dizer';
    await sendCheckin(db, channel, r);
    return `enviado (${r.reason}${r.usedLlm ? '' : ', fallback'})`;
  };
  const transcribe =
    config.TRANSCRIBE === 'whisper-cpp'
      ? createWhisperCppTranscriber({
          whisperBin: config.WHISPER_BIN,
          modelPath: config.WHISPER_MODEL!,
          ffmpegBin: config.FFMPEG_BIN,
          ...(config.WHISPER_THREADS ? { threads: config.WHISPER_THREADS } : {}),
        })
      : undefined;
  const handle = createInbox({
    report,
    ...(transcribe ? { transcribe } : {}),
    audioMaxSeconds: config.AUDIO_MAX_SECONDS,
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
  /** Mensagem proativa: respeita /pausar, exceto alertas críticos. */
  const notify: Notify = async (text, opts) => {
    if (!opts?.critical && getSetting<boolean>(db, 'proactive.paused')) return;
    await channel.send(text);
  };
  const scheduler = startScheduler(
    {
      db,
      logger: logger.child({ mod: 'scheduler' }),
      timeZone: config.TZ,
      cutoffHour: config.DAY_CUTOFF_HOUR,
    },
    buildJobs({
      db,
      logger: logger.child({ mod: 'jobs' }),
      timeZone: config.TZ,
      cutoffHour: config.DAY_CUTOFF_HOUR,
      notify,
      report,
      notifyImages: async (paths) => {
        if (getSetting<boolean>(db, 'proactive.paused') || !channel.sendImage) return;
        for (const p of paths) await channel.sendImage(p, null);
      },
      retryTurn: handle.retryTurn,
      checkin,
      waitChannel: () => waitChannelOpen(channel),
      config,
    }),
  );

  logger.info(
    {
      channel: channel.name,
      brain: brain.name,
      mcp: mcp.url,
      ingest: ingest.url,
      ...(dashboard ? { dashboard: dashboard.url } : {}),
    },
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
      scheduler.stop();
      await channel.stop();
      await handle.drain();
      await mcp.close();
      await ingest.close();
      await dashboard?.close();
      db.close();
      releaseLock();
    },
  };
}
