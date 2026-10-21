// Roda evals/cases/*.yaml contra o cérebro REAL (consome cota). Uso:
//   npm run eval                 → todos
//   npm run eval -- meals_text   → só os casos cujo id contém "meals_text"
// Cada caso usa um banco novo em memória com os seeds completos, o mesmo gateway do app e
// asserções sobre o estado do banco (estrutura, origens, gramas exatas ou faixas).
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { createBrain } from '../src/app.ts';
import type { Channel } from '../src/channels/types.ts';
import { runCli } from '../src/cli.ts';
import { REPO_ROOT, loadConfig } from '../src/config.ts';
import { openDb, type Db } from '../src/db/index.ts';
import { migrate } from '../src/db/migrate.ts';
import { createInbox } from '../src/gateway/inbox.ts';
import { createTurnRunner } from '../src/gateway/turn-runner.ts';
import { createLogger } from '../src/logger.ts';
import { saveNormalizedImage } from '../src/media/images.ts';
import { createTokenStore, startMcpServer } from '../src/mcp/server.ts';
import { runSeeds } from '../src/seeds/index.ts';
import { normalize } from '../src/text/normalize.ts';
import { formatLocalIso } from '../src/time.ts';
import { buildRegistry } from '../src/tools/index.ts';

type Range = number | [number, number];
type Case = {
  id: string;
  description: string;
  now: string;
  /** SQL executado antes dos passos (histórico de fixture, ex.: pesagens anteriores). */
  sql?: string[];
  /** `now` no passo salta o relógio (ex.: dias depois); sem ele, cada passo avança 1 min. */
  steps: { text?: string; image?: string; quote_previous?: boolean; now?: string }[];
  expect: {
    meals?: number;
    items?: { label: string; grams?: Range; origin?: string }[];
    min_items?: number;
    kcal?: [number, number];
    confidence?: string[];
    max_questions?: number;
    corrections?: number;
    local_date?: string;
    custom_food?: { name: string; protein_100g?: [number, number] };
    /** Óleo/manteiga como item, ou alimento da tabela já preparado com gordura (frito, refogado). */
    fat_accounted?: boolean;
    // ── treino ──
    /** Séries de trabalho (não aquecimento) registradas. */
    work_sets?: Range;
    warmup_sets?: Range;
    /** Regex de nomes de exercícios que precisam ter séries. */
    exercises?: string[];
    /** Exercícios criados (source = custom); 0 = nenhuma duplicata. */
    new_exercises?: number;
    /** Hora local de início da sessão (HH:MM). */
    session_start?: string;
    cardio_km?: Range;
    /** A última resposta não pode afirmar registro sem escrita (aviso da trava D-031). */
    no_unconfirmed_write?: boolean;
    // ── tom (Fase 8a) ──
    /** Pesagens registradas pelo chat. */
    body_metrics?: number;
    /** Regex (sem diferenciar maiúsculas) que a última resposta precisa / não pode casar. */
    reply_matches?: string[];
    reply_not_matches?: string[];
    /** O último passo virou só esta reação, sem texto. */
    reaction?: string;
    // ── memória (Fase 8b) ──
    /** Notas ativas ou resolvidas (não apagadas) por tipo. */
    coach_notes?: Partial<Record<'preference' | 'observation' | 'life_event', Range>>;
    /** Eventos de vida resolvidos. */
    notes_resolved?: Range;
  };
};

const CASES_DIR = path.join(REPO_ROOT, 'evals', 'cases');
const IMAGES_DIR = path.join(REPO_ROOT, 'evals', 'images');

const inRange = (v: number, r: Range) => (Array.isArray(r) ? v >= r[0] && v <= r[1] : Math.abs(v - r) < 0.5);
const fmtRange = (r: Range) => (Array.isArray(r) ? `${r[0]}–${r[1]}` : String(r));

function check(db: Db, c: Case): string[] {
  const fails: string[] = [];
  const e = c.expect;
  const meals = db.prepare('SELECT * FROM meals WHERE deleted_at IS NULL').all() as Record<string, unknown>[];
  const items = db
    .prepare(
      'SELECT i.* FROM meal_items i JOIN meals m ON m.id = i.meal_id WHERE i.deleted_at IS NULL AND m.deleted_at IS NULL',
    )
    .all() as { label_norm: string; label: string; grams: number; origin: string }[];
  if (e.meals !== undefined && meals.length !== e.meals)
    fails.push(`refeições: ${meals.length} (esperado ${e.meals})`);
  for (const want of e.items ?? []) {
    const re = new RegExp(normalize(want.label).replace(/ /g, '.*') || want.label, 'i');
    const hit = items.filter((i) => re.test(i.label_norm) || new RegExp(want.label, 'i').test(i.label));
    if (!hit.length) {
      fails.push(
        `item /${want.label}/ ausente (itens: ${items.map((i) => `${i.label} ${Math.round(i.grams)}g`).join(', ')})`,
      );
      continue;
    }
    // vale um item que atenda, ou a soma dos itens do mesmo alimento (ex.: "2 ovos" em dois itens)
    const total = hit.reduce((t, i) => t + i.grams, 0);
    const ok =
      hit.some(
        (i) =>
          (want.grams === undefined || inRange(i.grams, want.grams)) &&
          (want.origin === undefined || i.origin === want.origin),
      ) ||
      (hit.length > 1 &&
        want.grams !== undefined &&
        inRange(total, want.grams) &&
        (want.origin === undefined || hit.every((i) => i.origin === want.origin)));
    if (!ok) {
      fails.push(
        `item /${want.label}/: ${hit.map((i) => `${Math.round(i.grams)}g ${i.origin}`).join('; ')} (esperado ${want.grams !== undefined ? fmtRange(want.grams) + 'g ' : ''}${want.origin ?? ''})`,
      );
    }
  }
  if (e.min_items !== undefined && items.length < e.min_items)
    fails.push(`itens: ${items.length} (mínimo ${e.min_items})`);
  const kcal = meals.reduce((t, m) => t + (m.kcal as number), 0);
  if (e.kcal && !inRange(kcal, e.kcal)) fails.push(`kcal ${Math.round(kcal)} fora de ${fmtRange(e.kcal)}`);
  if (e.confidence && meals.some((m) => !e.confidence!.includes(m.confidence as string))) {
    fails.push(`confiança ${meals.map((m) => m.confidence).join(',')} (esperado ${e.confidence.join('|')})`);
  }
  if (e.max_questions !== undefined) {
    const q = db
      .prepare("SELECT count(*) FROM messages WHERE direction = 'out' AND text LIKE '%❓%'")
      .pluck()
      .get() as number;
    const pend = meals.filter((m) => m.pending_question).length;
    if (Math.max(q, pend) > e.max_questions)
      fails.push(`perguntas: ${Math.max(q, pend)} (máximo ${e.max_questions})`);
  }
  if (e.corrections !== undefined) {
    const n = db.prepare('SELECT count(*) FROM meal_corrections').pluck().get() as number;
    if (n < e.corrections) fails.push(`correções gravadas: ${n} (esperado ≥ ${e.corrections})`);
  }
  if (e.local_date && meals.some((m) => m.local_date !== e.local_date)) {
    fails.push(`local_date ${meals.map((m) => m.local_date).join(',')} (esperado ${e.local_date})`);
  }
  if (e.fat_accounted) {
    const fatItem = items.some((i) => /oleo|manteiga|gordura|azeite/.test(i.label_norm));
    const fatFood = (
      db
        .prepare(
          'SELECT f.name FROM meal_items i JOIN foods f ON f.id = i.food_id WHERE i.deleted_at IS NULL',
        )
        .pluck()
        .all() as string[]
    ).some((n) => /frit|refogad|com oleo|com manteiga/.test(normalize(n)));
    if (!fatItem && !fatFood) fails.push('gordura de preparo não contabilizada');
  }
  if (e.custom_food) {
    const foods = db
      .prepare("SELECT name, protein_100g FROM foods WHERE source = 'custom' AND deleted_at IS NULL")
      .all() as { name: string; protein_100g: number }[];
    const f = foods.find((x) => new RegExp(e.custom_food!.name, 'i').test(x.name));
    if (!f) fails.push(`alimento personalizado /${e.custom_food.name}/ ausente`);
    else if (e.custom_food.protein_100g && !inRange(f.protein_100g, e.custom_food.protein_100g)) {
      fails.push(`proteína/100 g ${f.protein_100g} fora de ${fmtRange(e.custom_food.protein_100g)}`);
    }
  }
  fails.push(...checkTraining(db, c));
  return fails;
}

/** Asserções sobre a última resposta: texto ou reação (Fase 8a). */
function checkReply(db: Db, c: Case, last: { text?: string; reaction?: string } | undefined): string[] {
  const e = c.expect;
  const fails: string[] = [];
  if (e.body_metrics !== undefined) {
    const n = db
      .prepare("SELECT count(*) FROM body_metrics WHERE source = 'chat' AND deleted_at IS NULL")
      .pluck()
      .get() as number;
    if (n !== e.body_metrics) fails.push(`pesagens pelo chat: ${n} (esperado ${e.body_metrics})`);
  }
  if (e.reaction !== undefined && last?.reaction !== e.reaction)
    fails.push(`reação ${last?.reaction ?? 'nenhuma'} (esperado ${e.reaction}; texto: ${last?.text ?? '—'})`);
  for (const [kind, want] of Object.entries(e.coach_notes ?? {})) {
    const n = db
      .prepare('SELECT count(*) FROM coach_notes WHERE kind = ? AND deleted_at IS NULL')
      .pluck()
      .get(kind) as number;
    if (!inRange(n, want)) fails.push(`notas ${kind}: ${n} (esperado ${fmtRange(want)})`);
  }
  if (e.notes_resolved !== undefined) {
    const n = db
      .prepare('SELECT count(*) FROM coach_notes WHERE resolved_at IS NOT NULL AND deleted_at IS NULL')
      .pluck()
      .get() as number;
    if (!inRange(n, e.notes_resolved))
      fails.push(`eventos resolvidos: ${n} (esperado ${fmtRange(e.notes_resolved)})`);
  }
  const text = last?.text ?? '';
  for (const re of e.reply_matches ?? [])
    if (!new RegExp(re, 'i').test(text)) fails.push(`resposta não casa /${re}/`);
  for (const re of e.reply_not_matches ?? [])
    if (new RegExp(re, 'i').test(text)) fails.push(`resposta casa /${re}/ (proibido)`);
  return fails;
}

function checkTraining(db: Db, c: Case): string[] {
  const e = c.expect;
  const fails: string[] = [];
  const sets = db
    .prepare(
      `SELECT e.name_pt, s.set_type FROM sets s JOIN exercises e ON e.id = s.exercise_id
        JOIN workout_sessions ws ON ws.id = s.session_id WHERE s.deleted_at IS NULL AND ws.deleted_at IS NULL`,
    )
    .all() as { name_pt: string; set_type: string }[];
  const work = sets.filter((x) => x.set_type !== 'warmup').length;
  const warm = sets.length - work;
  if (e.work_sets !== undefined && !inRange(work, e.work_sets))
    fails.push(`séries de trabalho: ${work} (esperado ${fmtRange(e.work_sets)})`);
  if (e.warmup_sets !== undefined && !inRange(warm, e.warmup_sets))
    fails.push(`aquecimento: ${warm} (esperado ${fmtRange(e.warmup_sets)})`);
  for (const name of e.exercises ?? [])
    if (!sets.some((x) => new RegExp(name, 'i').test(normalize(x.name_pt))))
      fails.push(
        `exercício /${name}/ sem séries (tem: ${[...new Set(sets.map((x) => x.name_pt))].join(', ')})`,
      );
  if (e.new_exercises !== undefined) {
    const n = db
      .prepare("SELECT count(*) FROM exercises WHERE source = 'custom' AND deleted_at IS NULL")
      .pluck()
      .get() as number;
    if (n !== e.new_exercises) fails.push(`exercícios criados: ${n} (esperado ${e.new_exercises})`);
  }
  if (e.session_start) {
    const at = db
      .prepare('SELECT started_at FROM workout_sessions WHERE deleted_at IS NULL ORDER BY id LIMIT 1')
      .pluck()
      .get() as string | undefined;
    const local = at ? formatLocalIso(at, 'America/Sao_Paulo').slice(11, 16) : 'nenhuma';
    if (local !== e.session_start) fails.push(`início da sessão ${local} (esperado ${e.session_start})`);
  }
  if (e.cardio_km !== undefined) {
    const m = db
      .prepare('SELECT sum(distance_m) FROM cardio_sessions WHERE deleted_at IS NULL')
      .pluck()
      .get() as number | null;
    if (m === null || !inRange(m / 1000, e.cardio_km))
      fails.push(
        `cardio ${m === null ? 'sem distância' : `${m / 1000} km`} (esperado ${fmtRange(e.cardio_km)})`,
      );
  }
  if (e.no_unconfirmed_write) {
    const out = db.prepare("SELECT text FROM messages WHERE direction = 'out'").pluck().all() as string[];
    if (out.some((t) => t.includes('nada foi gravado nesta mensagem')))
      fails.push('trava D-031 disparou (afirmou registro sem gravar)');
  }
  return fails;
}

await runCli(async () => {
  const filter = process.argv[2];
  const config = loadConfig({ ...process.env, CHANNEL: 'terminal' });
  const files = fs
    .readdirSync(CASES_DIR)
    .filter((f) => f.endsWith('.yaml'))
    .sort();
  const cases = files
    .map((f) => parse(fs.readFileSync(path.join(CASES_DIR, f), 'utf8')) as Case)
    .filter((c) => !filter || c.id.includes(filter));
  const logDir = path.join(config.DATA_DIR, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const logger = createLogger('info', fs.createWriteStream(path.join(logDir, 'eval.log'), { flags: 'a' }));
  const results: { id: string; status: 'pass' | 'fail' | 'skip'; detail: string; secs: number }[] = [];

  for (const c of cases) {
    const missing = c.steps
      .filter((s) => s.image && !fs.existsSync(path.join(IMAGES_DIR, s.image)))
      .map((s) => s.image);
    if (missing.length) {
      results.push({ id: c.id, status: 'skip', detail: `sem imagem: ${missing.join(', ')}`, secs: 0 });
      continue;
    }
    const started = Date.now();
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
    let clock = new Date(c.now).getTime();
    const now = () => new Date(clock).toISOString().replace(/\.\d{3}Z$/, 'Z');
    for (const q of c.sql ?? []) db.exec(q);
    const sent: string[] = [];
    let last: { text?: string; reaction?: string } | undefined;
    const channel: Channel = {
      name: 'terminal',
      start: async () => {},
      send: async (text) => {
        sent.push(text);
        last = { text };
        return { externalIds: [`eval-out-${sent.length}`] };
      },
      react: async (_m, emoji) => {
        last = { reaction: emoji };
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
    try {
      let i = 0;
      for (const s of c.steps) {
        if (s.now) clock = new Date(s.now).getTime();
        const imagePath = s.image
          ? await saveNormalizedImage(fs.readFileSync(path.join(IMAGES_DIR, s.image)), config.mediaDir)
          : null;
        await handle({
          externalId: `eval-in-${++i}`,
          text: s.text ?? null,
          imagePath,
          quotedExternalId: s.quote_previous ? `eval-out-${sent.length}` : null,
          at: now(),
        });
        clock += 60_000;
      }
      const fails = [...check(db, c), ...checkReply(db, c, last)];
      results.push({
        id: c.id,
        status: fails.length ? 'fail' : 'pass',
        detail: fails.length
          ? fails.join(' | ')
          : (last?.reaction ?? last?.text ?? '').split('\n')[0]!.slice(0, 90),
        secs: Math.round((Date.now() - started) / 1000),
      });
      fs.appendFileSync(
        path.join(logDir, 'eval-transcripts.log'),
        `\n=== ${c.id} ===\n${sent.join('\n---\n')}\n`,
      );
    } catch (e) {
      results.push({ id: c.id, status: 'fail', detail: `erro: ${(e as Error).message}`, secs: 0 });
    } finally {
      await mcp.close();
      db.close();
    }
  }

  const icon = { pass: '✅', fail: '❌', skip: '⏭️' };
  console.log('\nResultado dos evals:\n');
  for (const r of results)
    console.log(`${icon[r.status]} ${r.id.padEnd(24)} ${String(r.secs).padStart(3)}s  ${r.detail}`);
  const count = (s: string) => results.filter((r) => r.status === s).length;
  console.log(`\n${count('pass')} passaram · ${count('fail')} falharam · ${count('skip')} pulados`);
  if (count('fail')) process.exitCode = 1;
});
