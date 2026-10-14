import type { Db } from '../db/index.ts';
import { lastChatSession, sessionSets } from '../db/repos/training.ts';
import { setsCompact } from '../domain/training/format.ts';
import { isSessionOpen } from '../domain/training/types.ts';
import { daySummary } from '../tools/body.ts';
import { formatLocalIso, toLocalDate, weekdayPt, wallClock } from '../time.ts';
import type { ToolSettings } from '../tools/registry.ts';

export type QuotedEntity = { entity: string; entity_id: number };

export type TurnContextInput = {
  now: string;
  settings: ToolSettings;
  userText: string;
  images: string[];
  quoted?: QuotedEntity[];
  recentTurns: number;
  /** Instruções extras anexadas em turnos de relatório (runtime/prompts/report.md). */
  extraInstructions?: string;
  /** Turno atual (excluído do histórico). */
  currentTurnId?: number;
};

/** Orçamento aproximado do contexto (~2.000 tokens ≈ 8.000 caracteres). */
const MAX_CONTEXT_CHARS = 8000;

const fmtInt = (n: number) => Math.round(n).toLocaleString('pt-BR');

function snapshot(db: Db, localDate: string): string {
  const d = daySummary(db, localDate);
  const g = d.goals;
  const parts = [
    `kcal ${fmtInt(d.totals.kcal)}/${g.kcal !== undefined ? fmtInt(g.kcal) : '—'}`,
    `proteína ${fmtInt(d.totals.protein_g)}/${g.protein_g !== undefined ? fmtInt(g.protein_g) : '—'} g`,
    d.workout
      ? `treino: ${d.workout.routine ?? 'registrado'} (${d.workout.work_sets} séries)`
      : 'treino: nenhum registrado',
  ];
  if (d.cardio?.length) parts.push(`cardio: ${d.cardio.map((c) => c.activity).join(', ')}`);
  if (d.health?.steps != null)
    parts.push(`passos ${fmtInt(d.health.steps)}${g.steps !== undefined ? `/${fmtInt(g.steps)}` : ''}`);
  if (d.health?.sleep_minutes != null) {
    const m = d.health.sleep_minutes;
    parts.push(`sono ${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`);
  }
  return parts.join(' · ');
}

function openSession(db: Db, now: string, settings: ToolSettings): string | null {
  const s = lastChatSession(db);
  if (!s || !isSessionOpen(s.last_activity, now, settings.openSessionHours)) return null;
  const sets = sessionSets(db, s.id);
  const routine = s.routine_id
    ? (db.prepare('SELECT name FROM routines WHERE id = ?').pluck().get(s.routine_id) as string | undefined)
    : undefined;
  const w = wallClock(s.started_at, settings.timeZone);
  const hhmm = `${String(w.hour).padStart(2, '0')}:${String(w.minute).padStart(2, '0')}`;
  const exIds = [...new Set(sets.map((x) => x.exercise_id))];
  const head = `${routine ?? 'treino'} (sessão ${s.id}) iniciado ${hhmm} — ${exIds.length} exercícios, ${sets.filter((x) => x.set_type !== 'warmup').length} séries`;
  // Nomes e ids ajudam a resolver "supino 32kg 10 9 8" para o exercício já em andamento.
  const lines = exIds.map((id) => {
    const name = db.prepare('SELECT name_pt FROM exercises WHERE id = ?').pluck().get(id) as string;
    return `- ${name} (exercise_id ${id}): ${setsCompact(sets.filter((x) => x.exercise_id === id))}`;
  });
  return [head, ...lines].join('\n');
}

const ENTITY_PT: Record<string, [string, string]> = {
  set: ['série', 'séries'],
  workout_session: ['sessão de treino', 'sessões de treino'],
  routine: ['rotina', 'rotinas'],
  cardio_session: ['cardio', 'cardios'],
  exercise: ['exercício novo', 'exercícios novos'],
  exercise_alias: ['apelido', 'apelidos'],
  setting: ['meta', 'metas'],
  meal: ['refeição', 'refeições'],
  meal_item: ['item', 'itens'],
  body_metric: ['medida corporal', 'medidas corporais'],
};

/** "10 séries, 1 sessão de treino" a partir das contagens por entidade. */
export function describeEntities(counts: Record<string, number>): string {
  return Object.entries(counts)
    .map(([e, n]) => {
      const [one, many] = ENTITY_PT[e] ?? [e, e];
      return `${n} ${n === 1 ? one : many}`;
    })
    .join(', ');
}

function recentTurns(db: Db, limit: number, excludeTurnId?: number): string[] {
  const turns = db
    .prepare(
      `SELECT id FROM turns WHERE kind IN ('chat','command') AND status = 'done' AND id != ? ORDER BY id DESC LIMIT ?`,
    )
    .pluck()
    .all(excludeTurnId ?? -1, limit) as number[];
  return turns.reverse().map((id) => {
    const text = (
      db
        .prepare(
          "SELECT group_concat(coalesce(text, '[imagem]'), ' / ') FROM messages WHERE turn_id = ? AND direction = 'in'",
        )
        .pluck()
        .get(id) as string | null
    )?.slice(0, 200);
    const counts = db
      .prepare(
        "SELECT entity, count(*) n FROM audit_log WHERE turn_id = ? AND undone_at IS NULL AND action = 'create' GROUP BY entity ORDER BY min(id)",
      )
      .all(id) as { entity: string; n: number }[];
    const undone = db
      .prepare('SELECT count(*) FROM audit_log WHERE turn_id = ? AND undone_at IS NOT NULL')
      .pluck()
      .get(id) as number;
    const what = counts.length
      ? `registrou ${describeEntities(Object.fromEntries(counts.map((c) => [c.entity, c.n])))}`
      : undone
        ? 'desfeito'
        : 'consulta';
    return `- "${text ?? ''}" → ${what}`;
  });
}

function quotedBlock(db: Db, quoted: QuotedEntity[]): string {
  const lines = quoted.map((q) => {
    if (q.entity === 'workout_session') {
      const sets = sessionSets(db, q.entity_id);
      return `<quoted entity="workout_session" id="${q.entity_id}">${sets.length} séries registradas</quoted>`;
    }
    return `<quoted entity="${q.entity}" id="${q.entity_id}"></quoted>`;
  });
  return lines.join('\n');
}

/** Prompt do turno (ARCHITECTURE.md §5.2). Números vêm do banco; o modelo busca mais via tools. */
export function buildTurnPrompt(db: Db, input: TurnContextInput): string {
  const { now, settings } = input;
  const localDate = toLocalDate(now, settings.cutoffHour, settings.timeZone);
  const blocks: string[] = [
    `<now>${formatLocalIso(now, settings.timeZone)} (${weekdayPt(localDate)}) — dia contábil ${localDate}</now>`,
    `<today_snapshot>\n${snapshot(db, localDate)}\n</today_snapshot>`,
  ];
  const open = openSession(db, now, settings);
  if (open) blocks.push(`<open_session>${open}</open_session>`);
  const recent = recentTurns(db, input.recentTurns, input.currentTurnId);
  if (recent.length) blocks.push(`<recent_turns>\n${recent.join('\n')}\n</recent_turns>`);
  if (input.quoted?.length) blocks.push(quotedBlock(db, input.quoted));
  if (input.extraInstructions)
    blocks.push(`<instructions>\n${input.extraInstructions.trim()}\n</instructions>`);
  const msg = [...input.images.map((p) => `[imagem: ${p}]`), input.userText.trim()]
    .filter(Boolean)
    .join('\n');
  blocks.push(`<user_message>\n${msg}\n</user_message>`);

  const prompt = blocks.join('\n');
  if (prompt.length > MAX_CONTEXT_CHARS && recent.length) {
    // corta o histórico primeiro; mensagem do usuário e snapshot ficam
    return buildTurnPrompt(db, { ...input, recentTurns: Math.max(0, Math.floor(recent.length / 2)) });
  }
  return prompt;
}
