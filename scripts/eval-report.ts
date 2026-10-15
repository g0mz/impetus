// Eval do relatório semanal contra o cérebro REAL (consome cota): semana sintética com números
// conhecidos → turno de relatório → todo número do texto precisa existir no ReportBrief.
//   npm run eval:report
import { createBrain } from '../src/app.ts';
import { runCli } from '../src/cli.ts';
import { loadConfig } from '../src/config.ts';
import { openDb } from '../src/db/index.ts';
import { migrate } from '../src/db/migrate.ts';
import { upsertExercise } from '../src/db/repos/exercises.ts';
import { createTurnRunner } from '../src/gateway/turn-runner.ts';
import { createLogger } from '../src/logger.ts';
import { createTokenStore, startMcpServer } from '../src/mcp/server.ts';
import { numbersNotInBrief } from '../src/reports/verify.ts';
import { generateReport } from '../src/reports/service.ts';
import { buildRegistry } from '../src/tools/index.ts';
import { seedReportWeek } from '../tests/fixtures/report-week.ts';

const NOW = '2026-10-18T23:00:00Z';

await runCli(async () => {
  const config = loadConfig({ ...process.env, CHANNEL: 'terminal' });
  const logger = createLogger('warn');
  const db = openDb(':memory:');
  migrate(db);
  const ex = (name_pt: string, load_kind: 'total' | 'per_hand', primary: 'upper_back' | 'chest') =>
    upsertExercise(db, {
      name_pt,
      name_en: null,
      category: 'strength',
      equipment: load_kind === 'total' ? 'barbell' : 'dumbbell',
      load_kind,
      primary_muscles: [primary],
      secondary_muscles: [],
      is_compound: true,
      increment_kg: 2.5,
      source: 'custom',
      source_id: null,
    });
  seedReportWeek(db, {
    now: NOW,
    remada: ex('Remada curvada com barra', 'total', 'upper_back'),
    supino: ex('Supino inclinado com halteres', 'per_hand', 'chest'),
  });
  const settings = {
    cutoffHour: config.DAY_CUTOFF_HOUR,
    timeZone: config.TZ,
    openSessionHours: config.OPEN_SESSION_HOURS,
  };
  const registry = buildRegistry();
  const tokens = createTokenStore();
  const mcp = await startMcpServer({ db, registry, tokens, settings, logger }, 0);
  try {
    const runTurn = createTurnRunner({
      db,
      brain: createBrain(config, mcp.url, logger),
      tokens,
      settings,
      models: { fast: config.MODEL_FAST, vision: config.MODEL_VISION, report: config.MODEL_REPORT },
      recentTurns: config.CONTEXT_RECENT_TURNS,
      retryDelayMs: config.BRAIN_RETRY_DELAY_MS,
      logger,
      clock: () => NOW,
    });
    const r = await generateReport({
      db,
      kind: 'weekly',
      now: NOW,
      cutoffHour: settings.cutoffHour,
      timeZone: settings.timeZone,
      runTurn,
      logger,
    });
    console.log(`\n${r.text}\n`);
    const fails: string[] = [];
    if (!r.usedLlm) fails.push('cérebro não redigiu (saiu o fallback)');
    const extra = numbersNotInBrief(r.text, r.brief);
    if (extra.length) fails.push(`números fora do brief: ${extra.join(', ')}`);
    if (r.text.length > 1400) fails.push(`texto longo: ${r.text.length} caracteres`);
    if (!/➡️ Foco d/.test(r.text)) fails.push('sem "➡️ Foco da semana"');
    console.log(
      fails.length ? `❌ ${fails.join(' | ')}` : '✅ relatório semanal: números idênticos ao brief',
    );
    if (fails.length) process.exitCode = 1;
  } finally {
    await mcp.close();
    db.close();
  }
});
