import { addDays, weekdayIndex } from '../../time.ts';

export type RoutineRef = { id: number; name: string };

/** Agenda semanal: dia da semana (0 = domingo) → rotina. Dia ausente = descanso. */
export type WeeklySchedule = Map<number, RoutineRef>;

export type PlanOverride = {
  id: number;
  from_local_date: string;
  until_local_date: string;
  text: string;
  /** Dia da semana → rotina (null = folga). Ausente = o ajuste só informa, não muda a sessão. */
  weekday_changes: Map<number, RoutineRef | null> | null;
};

export type PlannedDay = {
  local_date: string;
  routine: RoutineRef | null;
  /** schedule = agenda normal; override = mudado por um ajuste; none = sem agenda definida. */
  source: 'schedule' | 'override' | 'none';
  /** Ajustes ativos no dia (inclusive os que só informam, como "academia de hotel"). */
  overrides: { id: number; text: string; until_local_date: string }[];
};

export const WEEKDAY_KEYS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'] as const;
export type WeekdayKey = (typeof WEEKDAY_KEYS)[number];

export const covers = (o: PlanOverride, localDate: string) =>
  o.from_local_date <= localDate && localDate <= o.until_local_date;

/**
 * Sessão planejada de um dia: agenda semanal, com os ajustes temporários por cima. Entre ajustes que
 * mudam o mesmo dia da semana, vale o de maior id (o mais recente).
 */
export function plannedFor(
  localDate: string,
  schedule: WeeklySchedule,
  overrides: PlanOverride[],
): PlannedDay {
  const wd = weekdayIndex(localDate);
  const active = overrides.filter((o) => covers(o, localDate)).sort((a, b) => a.id - b.id);
  let routine = schedule.get(wd) ?? null;
  let source: PlannedDay['source'] = schedule.size ? 'schedule' : 'none';
  for (const o of active) {
    if (o.weekday_changes?.has(wd)) {
      routine = o.weekday_changes.get(wd) ?? null;
      source = 'override';
    }
  }
  return {
    local_date: localDate,
    routine,
    source,
    overrides: active.map((o) => ({ id: o.id, text: o.text, until_local_date: o.until_local_date })),
  };
}

/** Os próximos `days` dias a partir de `localDate` (inclusive). */
export function plannedWeek(
  localDate: string,
  schedule: WeeklySchedule,
  overrides: PlanOverride[],
  days = 7,
): PlannedDay[] {
  return Array.from({ length: days }, (_, i) => plannedFor(addDays(localDate, i), schedule, overrides));
}
