import { z } from 'zod';
import type { Db } from '../db/index.ts';
import {
  activeOverrides,
  getOverrideRow,
  insertOverride,
  loadSchedule,
  replaceSchedule,
  scheduleRows,
} from '../db/repos/plan.ts';
import { findRoutine } from '../db/repos/training.ts';
import {
  WEEKDAY_KEYS,
  plannedFor,
  plannedWeek,
  type PlannedDay,
  type WeekdayKey,
} from '../domain/training/schedule.ts';
import { addDays, formatDayMonth, toLocalDate, weekdayPt } from '../time.ts';
import { defineTool, err, ok, type ToolContext, type ToolSettings } from './registry.ts';

const weekday = z.enum(WEEKDAY_KEYS);
const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use AAAA-MM-DD (data local)');
const wdIndex = (k: WeekdayKey) => WEEKDAY_KEYS.indexOf(k);
const MAX_OVERRIDE_DAYS = 60;

const today = (ctx: Pick<ToolContext, 'now' | 'settings'>) =>
  toLocalDate(ctx.now, ctx.settings.cutoffHour, ctx.settings.timeZone);

const routineNames = (db: Db) =>
  db.prepare('SELECT name FROM routines WHERE deleted_at IS NULL ORDER BY name').pluck().all() as string[];

/** Dia planejado em formato de resposta (usado também por get_day_summary e get_next_targets). */
export function describePlanned(d: PlannedDay) {
  return {
    local_date: d.local_date,
    date: formatDayMonth(d.local_date),
    weekday: weekdayPt(d.local_date),
    routine: d.routine?.name ?? null,
    source: d.source,
    ...(d.overrides.length
      ? { overrides: d.overrides.map((o) => ({ ...o, until: formatDayMonth(o.until_local_date) })) }
      : {}),
  };
}

/** Sessão planejada de um dia, ou undefined se não há agenda nem ajuste. */
export function plannedDay(db: Db, localDate: string) {
  const schedule = loadSchedule(db);
  const overrides = activeOverrides(db, localDate);
  if (!schedule.size && !overrides.length) return undefined;
  return plannedFor(localDate, schedule, overrides);
}

export const plannedToday = (ctx: { db: Db; now: string; settings: ToolSettings }) =>
  plannedDay(ctx.db, today(ctx));

export const setWeeklyScheduleTool = defineTool({
  name: 'set_weekly_schedule',
  scope: 'write',
  description:
    'Define a agenda semanal das rotinas, substituindo a anterior inteira ("upper A seg e qui, lower A ter e sex"). ' +
    'Um item por dia de treino; dia ausente = descanso. days vazio apaga a agenda. Para mudanças temporárias ' +
    '(viagem, semana corrida), use set_plan_override.',
  input: z
    .object({ days: z.array(z.object({ weekday, routine_name: z.string().trim().min(1) })).max(7) })
    .superRefine((v, c) => {
      const seen = new Set<string>();
      for (const [i, d] of v.days.entries()) {
        if (seen.has(d.weekday))
          c.addIssue({ code: 'custom', path: ['days', i, 'weekday'], message: `${d.weekday} repetido` });
        seen.add(d.weekday);
      }
    }),
  handler: (ctx, { days }) => {
    const rows: { weekday: number; routine_id: number }[] = [];
    for (const d of days) {
      const r = findRoutine(ctx.db, d.routine_name);
      if (!r) return err('NOT_FOUND', `rotina "${d.routine_name}" não existe`, routineNames(ctx.db));
      rows.push({ weekday: wdIndex(d.weekday), routine_id: r.id });
    }
    const before = scheduleRows(ctx.db);
    replaceSchedule(ctx.db, rows, ctx.now);
    ctx.audit('routine_schedule', 0, 'update', before, scheduleRows(ctx.db));
    const schedule = loadSchedule(ctx.db);
    return ok({
      schedule: WEEKDAY_KEYS.flatMap((k, i) => {
        const r = schedule.get(i);
        return r ? [{ weekday: k, routine: r.name }] : [];
      }),
    });
  },
});

export const setPlanOverrideTool = defineTool({
  name: 'set_plan_override',
  scope: 'write',
  description:
    'Ajuste temporário do plano, de from_date até until_date (datas locais; from_date padrão = hoje). Muda sessões, ' +
    'nunca metas. text descreve o ajuste ("viagem a SP, só academia de hotel"). changes move ou cancela sessões nesse ' +
    'período: [{weekday:"qui", routine_name:null}, {weekday:"sex", routine_name:"upper B"}]. Sem changes, o ajuste só ' +
    'informa (aparece no contexto e no check-in). Vence sozinho depois de until_date.',
  input: z
    .object({
      from_date: localDate.optional(),
      until_date: localDate,
      text: z.string().trim().min(3).max(200),
      changes: z
        .array(z.object({ weekday, routine_name: z.string().trim().min(1).nullable() }))
        .max(7)
        .optional(),
    })
    .superRefine((v, c) => {
      const keys = (v.changes ?? []).map((x) => x.weekday);
      if (new Set(keys).size !== keys.length)
        c.addIssue({ code: 'custom', path: ['changes'], message: 'dia da semana repetido' });
    }),
  handler: (ctx, input) => {
    const from = input.from_date ?? today(ctx);
    if (input.until_date < from) return err('VALIDATION', 'until_date antes de from_date');
    if (input.until_date > addDays(from, MAX_OVERRIDE_DAYS))
      return err('VALIDATION', `ajuste temporário vai até ${MAX_OVERRIDE_DAYS} dias; para mudar de vez, use set_weekly_schedule`);
    let changes: Record<string, number | null> | null = null;
    if (input.changes?.length) {
      changes = {};
      for (const ch of input.changes) {
        if (ch.routine_name === null) {
          changes[wdIndex(ch.weekday)] = null;
          continue;
        }
        const r = findRoutine(ctx.db, ch.routine_name);
        if (!r) return err('NOT_FOUND', `rotina "${ch.routine_name}" não existe`, routineNames(ctx.db));
        changes[wdIndex(ch.weekday)] = r.id;
      }
    }
    const id = insertOverride(ctx.db, {
      from,
      until: input.until_date,
      text: input.text,
      changes,
      turnId: ctx.turnId,
      now: ctx.now,
    });
    ctx.audit('plan_override', id, 'create', undefined, getOverrideRow(ctx.db, id));
    const week = plannedWeek(from, loadSchedule(ctx.db), activeOverrides(ctx.db, from));
    return ok({
      override_id: id,
      from: formatDayMonth(from),
      until: formatDayMonth(input.until_date),
      week: week.map(describePlanned),
    });
  },
});

export const endPlanOverrideTool = defineTool({
  name: 'end_plan_override',
  scope: 'write',
  description: 'Cancela um ajuste temporário antes do fim ("voltei antes", "esquece a mudança da sexta").',
  input: z.object({ override_id: z.number().int().positive() }),
  handler: (ctx, { override_id }) => {
    const before = getOverrideRow(ctx.db, override_id);
    if (!before || before.deleted_at) return err('NOT_FOUND', `ajuste ${override_id} não existe`);
    ctx.db.prepare('UPDATE plan_overrides SET deleted_at = ? WHERE id = ?').run(ctx.now, override_id);
    ctx.audit('plan_override', override_id, 'delete', before);
    return ok({ override_id, ended: true });
  },
});

export const getWeekPlanTool = defineTool({
  name: 'get_week_plan',
  scope: 'read',
  description:
    'Sessões planejadas dos próximos dias (agenda semanal + ajustes): "o que tenho essa semana?", "que treino é amanhã?".',
  input: z.object({ from_date: localDate.optional(), days: z.number().int().min(1).max(14).default(7) }),
  handler: (ctx, { from_date, days }) => {
    const from = from_date ?? today(ctx);
    const schedule = loadSchedule(ctx.db);
    if (!schedule.size && !activeOverrides(ctx.db, from).length)
      return ok({ days: [] }, ['sem agenda semanal: pergunte em que dias ele faz cada rotina e use set_weekly_schedule']);
    return ok({ days: plannedWeek(from, schedule, activeOverrides(ctx.db, from), days).map(describePlanned) });
  },
});

export const planTools = [setWeeklyScheduleTool, setPlanOverrideTool, endPlanOverrideTool, getWeekPlanTool];
