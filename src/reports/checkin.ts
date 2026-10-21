import fs from 'node:fs';
import path from 'node:path';
import type { Channel } from '../channels/types.ts';
import { REPO_ROOT } from '../config.ts';
import type { Db } from '../db/index.ts';
import { activeNotes } from '../db/repos/coach-notes.ts';
import { insertMessage } from '../db/repos/messages.ts';
import type { RunTurn } from '../gateway/turn-runner.ts';
import type { Logger } from '../logger.ts';
import { addDays, formatDayMonth, toLocalDate, weekdayPt } from '../time.ts';
import { describePlanned, plannedDay } from '../tools/plan.ts';
import type { ToolSettings } from '../tools/registry.ts';
import { computeTargets } from '../tools/training.ts';

export const CHECKIN_PROMPT_FILE = path.join(REPO_ROOT, 'runtime', 'prompts', 'checkin.md');
/** Noite curta: abaixo disso o check-in sugere manter as cargas (Fase 8d). */
export const SHORT_SLEEP_MIN = 360;

export type CheckinBrief = {
  local_date: string;
  date: string;
  weekday: string;
  planned: ReturnType<typeof describePlanned> | null;
  targets: { exercise: string; last?: string; target?: string; rule: string }[];
  sleep_minutes: number | null;
  short_sleep: boolean;
  life_events_due: { note_id: number; text: string }[];
  missing_yesterday: string[];
};

/**
 * Brief determinístico do check-in da manhã. `send` = há algo a dizer: sessão planejada, noite curta ou evento
 * de vida vencendo hoje. Dado faltando de ontem sozinho não justifica mensagem (evita cobrança).
 */
export function buildCheckinBrief(
  db: Db,
  now: string,
  settings: ToolSettings,
): { send: boolean; reason: string; brief: CheckinBrief } {
  const localDate = toLocalDate(now, settings.cutoffHour, settings.timeZone);
  const planned = plannedDay(db, localDate);
  const routine = planned?.routine?.name;
  const targets = routine
    ? (computeTargets({ db }, routine)?.targets ?? []).map((x) => ({
        exercise: x.exercise,
        rule: x.rule,
        ...('last' in x && x.last ? { last: String(x.last) } : {}),
        ...('target' in x && x.target ? { target: String(x.target) } : {}),
      }))
    : [];
  const sleep = db
    .prepare('SELECT sleep_minutes FROM health_daily WHERE local_date = ?')
    .pluck()
    .get(localDate) as number | null | undefined;
  const events = activeNotes(db)
    .filter((n) => n.kind === 'life_event' && n.due_local_date !== null && n.due_local_date <= localDate)
    .map((n) => ({ note_id: n.id, text: n.text }));
  const yesterday = addDays(localDate, -1);
  const count = (sql: string) => db.prepare(sql).pluck().get(yesterday) as number;
  const missing: string[] = [];
  if (!count('SELECT count(*) FROM meals WHERE local_date = ? AND deleted_at IS NULL'))
    missing.push('refeições');
  const plannedYesterday = plannedDay(db, yesterday)?.routine;
  if (
    plannedYesterday &&
    !count('SELECT count(*) FROM workout_sessions WHERE local_date = ? AND deleted_at IS NULL')
  )
    missing.push(`treino (${plannedYesterday.name})`);

  const shortSleep = sleep !== null && sleep !== undefined && sleep < SHORT_SLEEP_MIN;
  const brief: CheckinBrief = {
    local_date: localDate,
    date: formatDayMonth(localDate),
    weekday: weekdayPt(localDate),
    planned: planned ? describePlanned(planned) : null,
    targets,
    sleep_minutes: sleep ?? null,
    short_sleep: shortSleep,
    life_events_due: events,
    missing_yesterday: missing,
  };
  const reasons = [
    routine && 'sessão planejada',
    shortSleep && 'noite curta',
    events.length && 'evento de vida',
  ]
    .filter(Boolean)
    .join(', ');
  return { send: Boolean(reasons), reason: reasons || 'nada a dizer', brief };
}

const fmtSleep = (m: number) => `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;

/** Texto sem LLM, usado quando o cérebro está desligado ou falha. */
export function renderCheckinFallback(b: CheckinBrief): string {
  const lines: string[] = [];
  const routine = b.planned?.routine;
  lines.push(routine ? `☀️ Bom dia! Hoje: *${routine}*.` : '☀️ Bom dia! Hoje é descanso no plano.');
  for (const t of b.targets.slice(0, 6))
    lines.push(
      t.rule === 'first_time'
        ? `• ${t.exercise}: primeira vez, ache a carga`
        : `• ${t.exercise}: ${t.target ?? t.last ?? ''}`,
    );
  if (b.short_sleep && b.sleep_minutes !== null)
    lines.push(`Dormiu ${fmtSleep(b.sleep_minutes)}: mantenha as cargas e corte a última série se pesar.`);
  for (const e of b.life_events_due) lines.push(`E aí, ${e.text}: como ficou?`);
  return lines.join('\n');
}

/**
 * Check-in diário (Fase 8d): brief no código; o cérebro só redige, em turno somente leitura. Sem nada a dizer,
 * devolve null sem chamar o cérebro. Se o cérebro falhar, usa o fallback.
 */
export async function generateCheckin(deps: {
  db: Db;
  now: string;
  settings: ToolSettings;
  runTurn?: RunTurn;
  logger: Logger;
}): Promise<{ text: string; turnId: number | null; usedLlm: boolean; reason: string } | null> {
  const { send, reason, brief } = buildCheckinBrief(deps.db, deps.now, deps.settings);
  if (!send) return null;
  if (deps.runTurn) {
    const instructions = fs.existsSync(CHECKIN_PROMPT_FILE)
      ? fs.readFileSync(CHECKIN_PROMPT_FILE, 'utf8')
      : '';
    const outcome = await deps.runTurn({
      mode: 'checkin',
      userText: `Escreva o check-in da manhã (${brief.weekday}, ${brief.date}).`,
      images: [],
      inboundMessageIds: [],
      extraInstructions: `${instructions}\n<checkin_brief>\n${JSON.stringify(brief)}\n</checkin_brief>`,
    });
    if (outcome.status === 'done' && outcome.text.trim())
      return { text: outcome.text.trim(), turnId: outcome.turnId, usedLlm: true, reason };
    deps.logger.warn({ status: outcome.status }, 'check-in: cérebro falhou, usando fallback');
    return { text: renderCheckinFallback(brief), turnId: outcome.turnId, usedLlm: false, reason };
  }
  return { text: renderCheckinFallback(brief), turnId: null, usedLlm: false, reason };
}

/** Envia o check-in e grava a mensagem com o turno, para aparecer no <recent_turns> da resposta dele. */
export async function sendCheckin(
  db: Db,
  channel: Pick<Channel, 'name' | 'send'>,
  r: { text: string; turnId: number | null },
): Promise<void> {
  const { externalIds } = await channel.send(r.text);
  for (const externalId of externalIds)
    insertMessage(db, {
      channel: channel.name,
      direction: 'out',
      external_id: externalId,
      kind: 'text',
      text: r.text,
      turn_id: r.turnId,
    });
}
