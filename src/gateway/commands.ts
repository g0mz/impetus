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
import { GOAL_ALIASES, GOAL_KEYS, getGoals, type GoalKey } from '../tools/body.ts';
import { callTool, type Registry, type ToolSettings } from '../tools/registry.ts';
import { computeTargets } from '../tools/training.ts';
import { formatDayMonth } from '../time.ts';

export type CommandContext = { db: Db; registry: Registry; settings: ToolSettings; now: string };
export type CommandResult = { text: string; turnId?: number };

/** "/treino upper B" → { name: 'treino', args: 'upper B' }; texto sem "/" → null. */
export function parseCommand(text: string): { name: string; args: string } | null {
  const m = /^\/(\S+)\s*([\s\S]*)$/.exec(text.trim());
  return m ? { name: m[1]!.toLowerCase(), args: m[2]!.trim() } : null;
}

/** Comandos previstos no SPEC §6 que chegam em fases seguintes. */
const LATER = new Set(['hoje', 'peso', 'relatorio', 'status', 'pausar', 'retomar']);

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
