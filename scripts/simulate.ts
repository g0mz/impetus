// Simulação por persona (Fase 8f): um LLM faz o papel do usuário ao longo de dias, contra o mesmo gateway do app,
// com banco em memória e relógio simulado; no fim, um LLM-juiz avalia o tom pela rubrica da Fase 8a.
// Consome cota: rode só quando pedido.
//   npm run simulate -- evals/personas/semana_tipica.md
//   npm run simulate -- evals/personas/sumico.md --no-judge
import fs from 'node:fs';
import path from 'node:path';
import { createBrain, createPlainLlm } from '../src/app.ts';
import type { Channel } from '../src/channels/types.ts';
import { runCli } from '../src/cli.ts';
import { loadConfig } from '../src/config.ts';
import { openDb } from '../src/db/index.ts';
import { migrate } from '../src/db/migrate.ts';
import { createInbox } from '../src/gateway/inbox.ts';
import { createTurnRunner } from '../src/gateway/turn-runner.ts';
import { t } from '../src/i18n/pt-br.ts';
import { createLogger } from '../src/logger.ts';
import { createTokenStore, startMcpServer } from '../src/mcp/server.ts';
import { generateCheckin, sendCheckin } from '../src/reports/checkin.ts';
import { runSeeds } from '../src/seeds/index.ts';
import { formatDateTimeBR } from '../src/time.ts';
import { buildRegistry } from '../src/tools/index.ts';
import { parsePersona } from './persona.ts';

const PLAYER_SYSTEM = (who: string) =>
  [
    'Você está interpretando uma pessoa real que conversa pelo WhatsApp com o próprio coach de treino e nutrição.',
    who,
    'Escreva SOMENTE a próxima mensagem dela: curta, português do Brasil coloquial, sem aspas, sem explicações,',
    'sem narrar o que vai fazer. Siga a instrução do momento; leia a conversa para responder com coerência.',
  ].join('\n');

const RUBRIC = [
  'numero_com_significado: números vêm com o que significam contra o histórico dele, não soltos',
  'pessoa_antes_do_dado: quando ele conta algo da vida, o coach fala disso antes de analisar números',
  'deslize_sem_compensacao: deslize tratado como normal, sem propor compensar (cortar comida, treino extra, jejum)',
  'pesagem_ruido: uma pesagem isolada tratada como ruído, apontando a tendência',
  'pergunta_antes_de_aconselhar: em sono, estresse ou desânimo, faz uma pergunta antes de aconselhar',
  'sem_fecho_de_atendente: nada de "posso ajudar em algo mais", "estou aqui"',
  'memoria: lembra preferências pedidas e pergunta de eventos (viagem, dor) quando chega a hora',
  'formatos_e_brevidade: respeita os formatos de registro e responde curto',
];

const JUDGE_SYSTEM = [
  'Você avalia as respostas de um coach de treino por WhatsApp. Seja rigoroso e concreto.',
  'Para cada critério, dê nota de 1 a 5 (ou null se a conversa não deu ocasião de avaliar) e um motivo curto citando',
  'uma resposta. Responda SOMENTE com JSON: {"criterios": {"<id>": {"nota": n|null, "motivo": "..."}}, "resumo": "..."}',
].join('\n');

await runCli(async () => {
  const file = process.argv.slice(2).find((a) => a.endsWith('.md'));
  if (!file) throw new Error('uso: npm run simulate -- evals/personas/<nome>.md [--no-judge]');
  const judge = !process.argv.includes('--no-judge');
  const persona = parsePersona(fs.readFileSync(file, 'utf8'));
  const config = loadConfig({ ...process.env, CHANNEL: 'terminal' });
  const logDir = path.join(config.DATA_DIR, 'logs');
  fs.mkdirSync(path.join(logDir, 'simulate'), { recursive: true });
  const logger = createLogger(
    'info',
    fs.createWriteStream(path.join(logDir, 'simulate.log'), { flags: 'a' }),
  );
  const llm = createPlainLlm(config);

  const db = openDb(':memory:');
  migrate(db);
  runSeeds(db);
  const registry = buildRegistry();
  const tokens = createTokenStore();
  const settings = {
    cutoffHour: config.DAY_CUTOFF_HOUR,
    timeZone: config.TZ,
    openSessionHours: config.OPEN_SESSION_HOURS,
  };
  const mcp = await startMcpServer({ db, registry, tokens, settings, logger }, 0);
  const brain = createBrain(config, mcp.url, logger);
  let clock = persona.moments[0]!.at;
  const now = () => clock;
  const transcript: string[] = [];
  let outSeq = 0;
  const channel: Channel = {
    name: 'terminal',
    start: async () => {},
    send: async (text) => {
      transcript.push(`coach: ${text}`);
      console.log(`  coach> ${text.replace(/\n/g, '\n         ')}`);
      return { externalIds: [`sim-out-${++outSeq}`] };
    },
    react: async (_m, emoji) => {
      transcript.push(`coach: [reação ${emoji}]`);
      console.log(`  coach> [reação ${emoji}]`);
      return true;
    },
    stop: async () => {},
  };
  const runTurn = createTurnRunner({
    db,
    brain,
    tokens,
    settings,
    models: { fast: config.MODEL_FAST, vision: config.MODEL_VISION, report: config.MODEL_REPORT },
    recentTurns: config.CONTEXT_RECENT_TURNS,
    retryDelayMs: config.BRAIN_RETRY_DELAY_MS,
    logger,
    clock: now,
  });
  const handle = createInbox({ db, channel, registry, settings, runTurn, logger, clock: now });

  console.log(`\n▶ ${persona.name} — ${persona.moments.length} momentos\n`);
  try {
    let inSeq = 0;
    for (const m of persona.moments) {
      clock = m.at;
      const when = formatDateTimeBR(m.at, config.TZ);
      transcript.push(`\n[${when}]`);
      console.log(`[${when}]${m.checkin ? ' check-in' : ''}`);
      if (m.checkin) {
        const r = await generateCheckin({ db, now: m.at, settings, runTurn, logger });
        if (r) await sendCheckin(db, channel, r);
        else transcript.push('(check-in calado)');
        continue;
      }
      const said = await llm({
        system: PLAYER_SYSTEM(persona.who),
        model: config.MODEL_REPORT,
        prompt: `Conversa até agora:\n${transcript.join('\n') || '(nenhuma)'}\n\nMomento atual: ${when}.\nInstrução: ${m.instruction}`,
      });
      if (!said.ok) throw new Error(`jogador da persona falhou: ${said.errorMessage}`);
      transcript.push(`usuário: ${said.text}`);
      console.log(`  você > ${said.text}`);
      await handle({
        externalId: `sim-in-${++inSeq}`,
        text: said.text,
        imagePath: null,
        quotedExternalId: null,
        at: m.at,
      });
    }

    const failed = db.prepare("SELECT count(*) FROM turns WHERE status != 'done'").pluck().get() as number;
    const unconfirmed = transcript.filter((l) => l.includes(t.unconfirmedWrite)).length;
    const out = path.join(logDir, 'simulate', `${path.basename(file, '.md')}-${Date.now()}.md`);
    let report = `# ${persona.name}\n\nTurnos com falha: ${failed} · avisos de registro não confirmado: ${unconfirmed}\n`;
    console.log(`\nTurnos com falha: ${failed} · avisos de registro não confirmado: ${unconfirmed}`);

    if (judge) {
      const verdict = await llm({
        system: JUDGE_SYSTEM,
        model: config.MODEL_REPORT,
        prompt: `Critérios:\n${RUBRIC.map((r) => `- ${r}`).join('\n')}\n\nConversa:\n${transcript.join('\n')}`,
      });
      const json = verdict.ok ? /\{[\s\S]*\}/.exec(verdict.text)?.[0] : undefined;
      if (!json) {
        report += `\nJuiz falhou: ${verdict.errorMessage ?? verdict.text.slice(0, 200)}\n`;
        console.log('Juiz falhou.');
      } else {
        const v = JSON.parse(json) as {
          criterios: Record<string, { nota: number | null; motivo: string }>;
          resumo?: string;
        };
        const rows = Object.entries(v.criterios);
        const notes = rows.map(([, c]) => c.nota).filter((n): n is number => typeof n === 'number');
        const avg = notes.length ? (notes.reduce((a, b) => a + b, 0) / notes.length).toFixed(1) : '—';
        report += `\n## Rubrica (média ${avg})\n\n${rows.map(([id, c]) => `- ${id}: ${c.nota ?? '—'} · ${c.motivo}`).join('\n')}\n\n${v.resumo ?? ''}\n`;
        console.log(`\nRubrica (média ${avg}):`);
        for (const [id, c] of rows) console.log(`  ${String(c.nota ?? '—').padStart(2)}  ${id}: ${c.motivo}`);
        if (notes.some((n) => n <= 2)) process.exitCode = 1;
      }
    }
    fs.writeFileSync(out, `${report}\n## Conversa\n${transcript.join('\n')}\n`);
    console.log(`\nTranscrição: ${out}`);
    if (failed) process.exitCode = 1;
  } finally {
    await mcp.close();
    db.close();
  }
});
