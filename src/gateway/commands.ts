import type { Db } from '../db/index.ts';
import { lastTurnWithPendingWrites } from '../db/repos/audit.ts';
import { searchExercises } from '../db/repos/exercises.ts';
import { exerciseSessions, getExercise, latestBodyweight } from '../db/repos/training.ts';
import { createTurn, finishTurn } from '../db/repos/turns.ts';
import { undoTurn } from '../db/undo.ts';
import { describeEntities } from '../brain/context-builder.ts';
import { fmtKg, setsCompact } from '../domain/training/format.ts';
import { bestE1rm } from '../domain/training/load.ts';
import { GOAL_LABELS, t } from '../i18n/pt-br.ts';
import { GOAL_ALIASES, GOAL_KEYS, daySummary, getGoals, type GoalKey } from '../tools/body.ts';
import { MEAL_TYPE_PT, type MealType } from '../domain/nutrition/meal-type.ts';
import { callTool, type Registry, type ToolSettings } from '../tools/registry.ts';
import { computeTargets } from '../tools/training.ts';
import { formatDayMonth, localDayBounds, toLocalDate } from '../time.ts';
import { setSetting } from '../db/repos/settings.ts';

export type CommandContext = {
  db: Db;
  registry: Registry;
  settings: ToolSettings;
  now: string;
  channelStatus?: () => string;
  claudeTokenExpiresAt?: string;
};
export type CommandResult = { text: string; turnId?: number };

/** "/treino upper B" → { name: 'treino', args: 'upper B' }; texto sem "/" → null. */
export function parseCommand(text: string): { name: string; args: string } | null {
  const m = /^\/(\S+)\s*([\s\S]*)$/.exec(text.trim());
  return m ? { name: m[1]!.toLowerCase(), args: m[2]!.trim() } : null;
}

/** Comandos previstos no SPEC §6 que chegam em fases seguintes. */
const LATER = new Set<string>();

export function runCommand(ctx: CommandContext, name: string, args: string): CommandResult {
  switch (name) {
    case 'ajuda':
    case 'help':
      return { text: t.help };
    case 'treino':
      return treino(ctx, args);
    case 'ultimo':
    case 'último':
      return ultimo(ctx, args);
    case 'metas':
      return metas(ctx);
    case 'meta':
      return meta(ctx, args);
    case 'desfazer':
      return desfazer(ctx);
    case 'status':
      return status(ctx);
    case 'hoje':
      return hoje(ctx);
    case 'peso':
      return peso(ctx, args);
    case 'recarga':
      return recarga(ctx);
    case 'pausar':
      return pausar(ctx, true);
    case 'retomar':
      return pausar(ctx, false);
    default:
      return { text: LATER.has(name) ? t.notYet(name) : t.unknownCommand(name) };
  }
}

function routineNames(db: Db): string[] {
  return db
    .prepare('SELECT name FROM routines WHERE deleted_at IS NULL ORDER BY name')
    .pluck()
    .all() as string[];
}

function treino(ctx: CommandContext, args: string): CommandResult {
  if (!args) return { text: t.usage('/treino <rotina>') };
  const res = computeTargets(ctx, args);
  if (!res) return { text: t.routineNotFound(args, routineNames(ctx.db)) };
  const header = res.last_date
    ? `📋 Último ${res.routine} (${formatDayMonth(res.last_date)})`
    : `📋 ${res.routine} — ainda sem treino registrado`;
  const lines = res.targets.map((x) =>
    x.rule === 'first_time'
      ? `• ${x.exercise}: primeira vez → registre a carga de referência`
      : `• ${x.exercise}: ${x.last} → alvo: ${x.target}${x.rule === 'deload' ? ' (deload)' : ''}`,
  );
  return { text: [header, ...lines].join('\n') };
}

function ultimo(ctx: CommandContext, args: string): CommandResult {
  if (!args) return { text: t.usage('/ultimo <exercício>') };
  const match = searchExercises(ctx.db, args, 1)[0];
  if (!match) return { text: t.exerciseNotFound(args) };
  const ex = getExercise(ctx.db, match.id)!;
  const sessions = exerciseSessions(ctx.db, ex.id, 3);
  if (!sessions.length) return { text: t.noHistory(ex.name_pt) };
  const bw = latestBodyweight(ctx.db);
  const lines = sessions.map((s) => {
    const e = bestE1rm(s.sets, ex.load_kind, bw);
    return `• ${formatDayMonth(s.local_date)}${s.routine ? ` (${s.routine})` : ''}: ${setsCompact(s.sets)}${e ? ` · e1RM ${fmtKg(e)}kg` : ''}`;
  });
  return { text: [`📈 ${ex.name_pt} — últimas sessões`, ...lines].join('\n') };
}

function fmtGoal(key: string, value: number): string {
  const g = GOAL_LABELS[key];
  return `${String(value).replace('.', ',')} ${g?.unit ?? ''}`.trim();
}

function metas(ctx: CommandContext): CommandResult {
  const goals = getGoals(ctx.db);
  const keys = GOAL_KEYS.filter((k) => goals[k] !== undefined);
  if (!keys.length) return { text: t.goalsEmpty };
  return {
    text: ['🎯 Metas', ...keys.map((k) => `• ${GOAL_LABELS[k]?.label ?? k}: ${fmtGoal(k, goals[k]!)}`)].join(
      '\n',
    ),
  };
}

/** Executa uma escrita dentro de um turno 'command' (auditado, desfazível). */
function inCommandTurn<T>(ctx: CommandContext, fn: (turnId: number) => T): { result: T; turnId: number } {
  const turnId = createTurn(ctx.db, 'command', ctx.now);
  const started = Date.now();
  try {
    const result = fn(turnId);
    finishTurn(ctx.db, turnId, { status: 'done', durationMs: Date.now() - started }, ctx.now);
    return { result, turnId };
  } catch (e) {
    finishTurn(ctx.db, turnId, { status: 'failed', error: String(e) }, ctx.now);
    throw e;
  }
}

function meta(ctx: CommandContext, args: string): CommandResult {
  const m = /^(\S+)\s+(\S+)$/.exec(args);
  if (!m) return { text: t.usage('/meta <chave> <valor>  (ex.: /meta proteina 150)') };
  const k = m[1]!.toLowerCase();
  const key: GoalKey | undefined =
    GOAL_ALIASES[k] ?? (GOAL_KEYS.includes(k as GoalKey) ? (k as GoalKey) : undefined);
  if (!key) return { text: t.goalUnknownKey(m[1]!) };
  const raw = m[2]!.toLowerCase();
  const value = ['remover', 'off', '-', 'nenhuma'].includes(raw) ? null : Number(raw.replace(',', '.'));
  if (value !== null && !Number.isFinite(value)) return { text: t.usage('/meta <chave> <número>') };

  const { result: env, turnId } = inCommandTurn(ctx, (turnId) =>
    callTool(
      ctx.registry,
      'set_goal',
      { key, value },
      { db: ctx.db, now: ctx.now, turnId, settings: ctx.settings, toolScope: 'all' },
    ),
  );
  if (!env.ok) return { text: `⚠️ ${env.error.message}`, turnId };
  const label = GOAL_LABELS[key]?.label ?? key;
  return { text: value === null ? t.goalRemoved(label) : t.goalSet(label, fmtGoal(key, value)), turnId };
}

function desfazer(ctx: CommandContext): CommandResult {
  const target = lastTurnWithPendingWrites(ctx.db);
  if (target === undefined) return { text: t.undoNothing };
  const { result, turnId } = inCommandTurn(ctx, () => undoTurn(ctx.db, target, ctx.now));
  return { text: t.undoDone(describeEntities(result.byEntity)), turnId };
}

function ago(iso: string | null | undefined, now: string): string {
  if (!iso) return 'nunca';
  const min = Math.round((new Date(now).getTime() - new Date(iso).getTime()) / 60000);
  if (min < 60) return `há ${min} min`;
  if (min < 48 * 60) return `há ${Math.round(min / 60)} h`;
  return `há ${Math.round(min / 1440)} dias`;
}

function status(ctx: CommandContext): CommandResult {
  const { db, now } = ctx;
  const one = <T>(sql: string, ...a: unknown[]) => db.prepare(sql).get(...a) as T | undefined;
  const lastTurn = one<{ status: string; started_at: string; duration_ms: number | null }>(
    "SELECT status, started_at, duration_ms FROM turns WHERE kind IN ('chat','report') ORDER BY id DESC LIMIT 1",
  );
  const { start } = localDayBounds(
    toLocalDate(now, ctx.settings.cutoffHour, ctx.settings.timeZone),
    ctx.settings.cutoffHour,
    ctx.settings.timeZone,
  );
  const today = one<{ n: number; cost: number | null }>(
    "SELECT count(*) n, sum(cost_usd) cost FROM turns WHERE kind IN ('chat','report') AND started_at >= ?",
    start,
  )!;
  const backup = one<{ finished_at: string; ok: number }>(
    "SELECT finished_at, ok FROM job_runs WHERE job = 'backup' ORDER BY id DESC LIMIT 1",
  );
  const health = one<{ at: string | null }>('SELECT max(received_at) at FROM health_raw')?.at;
  const lines = [
    '🩺 Status',
    `• Canal: ${ctx.channelStatus ? ctx.channelStatus() : 'terminal'}`,
    `• Último turno: ${lastTurn ? `${lastTurn.status} ${ago(lastTurn.started_at, now)}${lastTurn.duration_ms ? ` (${(lastTurn.duration_ms / 1000).toFixed(0)} s)` : ''}` : 'nenhum'}`,
    `• Hoje: ${today.n} turnos · custo estimado US$ ${(today.cost ?? 0).toFixed(2)}`,
    `• Último backup: ${backup ? `${backup.ok ? 'ok' : 'FALHOU'} ${ago(backup.finished_at, now)}` : 'nunca'}`,
    `• Último sync de saúde: ${ago(health, now)}`,
  ];
  if (ctx.claudeTokenExpiresAt) lines.push(`• Token Claude expira em ${ctx.claudeTokenExpiresAt}`);
  return { text: lines.join('\n') };
}

const n0 = (n: number) => Math.round(n).toLocaleString('pt-BR');

function hoje(ctx: CommandContext): CommandResult {
  const localDate = toLocalDate(ctx.now, ctx.settings.cutoffHour, ctx.settings.timeZone);
  const d = daySummary(ctx.db, localDate);
  const g = d.goals;
  const prot =
    g.protein_g !== undefined
      ? `${n0(d.totals.protein_g)}/${n0(g.protein_g)} g proteína${d.remaining?.protein_g && d.remaining.protein_g > 0 ? ` (faltam ${n0(d.remaining.protein_g)} g)` : ''}`
      : `${n0(d.totals.protein_g)} g proteína`;
  const kcal = g.kcal !== undefined ? `${n0(d.totals.kcal)}/${n0(g.kcal)} kcal` : `${n0(d.totals.kcal)} kcal`;
  const lines = [
    `📅 Hoje (${d.date})`,
    `🍽️ ${kcal} · ${prot} · C ${n0(d.totals.carbs_g)} g · G ${n0(d.totals.fat_g)} g`,
  ];
  for (const m of d.meals) {
    lines.push(
      `• ${m.meal_type ? MEAL_TYPE_PT[m.meal_type as MealType] : 'Refeição'}: ${n0(m.kcal)} kcal · ${n0(m.protein_g)} g P`,
    );
  }
  if (!d.meals.length) lines.push('• Nenhuma refeição registrada.');
  lines.push(
    d.workout
      ? `🏋️ ${d.workout.routine ?? 'Treino'}: ${d.workout.work_sets} séries`
      : '🏋️ Sem treino registrado',
  );
  for (const c of d.cardio ?? [])
    lines.push(`🏃 ${c.activity}${'duration_min' in c ? ` ${c.duration_min} min` : ''}`);
  const h = d.health as { steps?: number | null; sleep_minutes?: number | null } | undefined;
  const extra: string[] = [];
  if (h?.steps != null)
    extra.push(`🚶 ${n0(h.steps)} passos${g.steps !== undefined ? `/${n0(g.steps)}` : ''}`);
  if (h?.sleep_minutes != null)
    extra.push(`🛌 ${Math.floor(h.sleep_minutes / 60)}h${String(h.sleep_minutes % 60).padStart(2, '0')}`);
  if (extra.length) lines.push(extra.join(' · '));
  return { text: lines.join('\n') };
}

function peso(ctx: CommandContext, args: string): CommandResult {
  const v = Number(args.replace(',', '.').replace(/kg$/i, '').trim());
  if (!args || !Number.isFinite(v)) return { text: t.usage('/peso <kg>  (ex.: /peso 74,2)') };
  const { result: env, turnId } = inCommandTurn(ctx, (turnId) =>
    callTool(
      ctx.registry,
      'log_body_metric',
      { weight_kg: v },
      { db: ctx.db, now: ctx.now, turnId, settings: ctx.settings, toolScope: 'all' },
    ),
  );
  if (!env.ok) return { text: `⚠️ ${env.error.message}`, turnId };
  const d = env.data as { weight_trend_kg: number | null; delta_7d_kg: number | null };
  const kg = (n: number) => n.toFixed(1).replace('.', ',');
  const trend = d.weight_trend_kg !== null ? ` · tendência ${kg(d.weight_trend_kg)} kg` : '';
  const delta =
    d.delta_7d_kg !== null
      ? ` (${d.delta_7d_kg > 0 ? '+' : d.delta_7d_kg < 0 ? '−' : ''}${kg(Math.abs(d.delta_7d_kg))} kg em 7 dias)`
      : '';
  return { text: `⚖️ ${kg(v)} kg registrado${trend}${delta}`, turnId };
}

function pausar(ctx: CommandContext, paused: boolean): CommandResult {
  setSetting(ctx.db, 'proactive.paused', paused);
  if (paused) return { text: t.paused };
  // relatórios pulados durante a pausa nos últimos 7 dias: oferece gerar na hora
  const since = new Date(Date.parse(ctx.now) - 7 * 86400_000).toISOString();
  const skipped = ctx.db
    .prepare(
      "SELECT DISTINCT substr(job, 8, instr(job, ':') - 8) FROM job_runs WHERE job LIKE 'report.%:%' AND detail = 'pulado (pausado)' AND started_at >= ?",
    )
    .pluck()
    .all(since) as string[];
  const arg: Record<string, string> = { weekly: 'semana', monthly: 'mes', daily: 'dia' };
  const hints = skipped.filter((k) => arg[k]).map((k) => `/relatorio ${arg[k]}`);
  return {
    text: hints.length
      ? `${t.resumed}
${t.skippedReports(hints.join(' · '))}`
      : t.resumed,
  };
}

function recarga(ctx: CommandContext): CommandResult {
  const d = toLocalDate(ctx.now, ctx.settings.cutoffHour, ctx.settings.timeZone);
  setSetting(ctx.db, 'sim.last_recharge', d);
  return { text: t.rechargeSaved(formatDayMonth(d)) };
}
