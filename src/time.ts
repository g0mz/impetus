// Tempo: armazenamos UTC ISO; agregamos por `local_date` (dia contábil no fuso do usuário,
// com virada em DAY_CUTOFF_HOUR). Nada aqui presume ausência de horário de verão: usamos
// sempre a base de fusos (Intl/ICU).

export const DEFAULT_TIMEZONE = 'America/Sao_Paulo';
export const DEFAULT_CUTOFF_HOUR = 4;

type WallClock = { year: number; month: number; day: number; hour: number; minute: number; second: number };

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = partsFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    partsFormatters.set(timeZone, f);
  }
  return f;
}

function toDate(input: string | Date): Date {
  const d = typeof input === 'string' ? new Date(input) : input;
  if (Number.isNaN(d.getTime())) throw new RangeError(`Data inválida: ${String(input)}`);
  return d;
}

/** Relógio de parede no fuso informado. */
export function wallClock(input: string | Date, timeZone = DEFAULT_TIMEZONE): WallClock {
  const parts = partsFormatter(timeZone).formatToParts(toDate(input));
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

function ymd(year: number, month: number, day: number): string {
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
}

/** Soma dias a uma data de calendário `YYYY-MM-DD` (sem fuso). */
export function addDays(localDate: string, days: number): string {
  const [y, m, d] = parseLocalDate(localDate);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

function parseLocalDate(localDate: string): [number, number, number] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  if (!m) throw new RangeError(`local_date inválida: ${localDate}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * Dia contábil de um instante: data local no fuso, recuando um dia quando a hora local
 * é anterior a `cutoffHour` (ex.: refeição às 01:30 conta no dia anterior).
 */
export function toLocalDate(
  input: string | Date,
  cutoffHour = DEFAULT_CUTOFF_HOUR,
  timeZone = DEFAULT_TIMEZONE,
): string {
  const w = wallClock(input, timeZone);
  const date = ymd(w.year, w.month, w.day);
  return w.hour < cutoffHour ? addDays(date, -1) : date;
}

/** Offset do fuso (ms) no instante `utcMs`: local = utc + offset. */
function offsetAt(utcMs: number, timeZone: string): number {
  const w = wallClock(new Date(utcMs), timeZone);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(utcMs / 1000) * 1000;
}

/**
 * Instante UTC do relógio de parede `localDate hour:00` no fuso. Se o horário não existir
 * (salto do horário de verão), devolve o primeiro instante válido depois dele.
 */
export function zonedTimeToUtc(localDate: string, hour: number, timeZone = DEFAULT_TIMEZONE): Date {
  const [y, m, d] = parseLocalDate(localDate);
  const asUtc = Date.UTC(y, m - 1, d, hour);
  let guess = asUtc - offsetAt(asUtc, timeZone);
  guess = asUtc - offsetAt(guess, timeZone);
  const w = wallClock(new Date(guess), timeZone);
  const back = Date.UTC(w.year, w.month - 1, w.day, w.hour);
  return back < asUtc ? new Date(guess + (asUtc - back)) : new Date(guess);
}

/** Intervalo UTC [start, end) do dia contábil. */
export function localDayBounds(
  localDate: string,
  cutoffHour = DEFAULT_CUTOFF_HOUR,
  timeZone = DEFAULT_TIMEZONE,
): { start: string; end: string } {
  return {
    start: toUtcIso(zonedTimeToUtc(localDate, cutoffHour, timeZone)),
    end: toUtcIso(zonedTimeToUtc(addDays(localDate, 1), cutoffHour, timeZone)),
  };
}

/** UTC ISO-8601 com segundos e sufixo Z (ex.: 2026-10-13T23:41:00Z). */
export function toUtcIso(input: string | Date): string {
  return toDate(input)
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z');
}

export function nowUtcIso(): string {
  return toUtcIso(new Date());
}

const WEEKDAYS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

/** Dia da semana (0 = domingo … 6 = sábado) de uma data de calendário. */
export function weekdayIndex(localDate: string): number {
  const [y, m, d] = parseLocalDate(localDate);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Dia da semana em PT-BR de uma data de calendário. */
export function weekdayPt(localDate: string): string {
  return WEEKDAYS[weekdayIndex(localDate)] ?? '';
}

/** `2026-10-13` → `13/10`. */
export function formatDayMonth(localDate: string): string {
  const [, m, d] = parseLocalDate(localDate);
  return `${pad(d)}/${pad(m)}`;
}

/** Instante → `13/10 20:41` no fuso. */
export function formatDateTimeBR(input: string | Date, timeZone = DEFAULT_TIMEZONE): string {
  const w = wallClock(input, timeZone);
  return `${pad(w.day)}/${pad(w.month)} ${pad(w.hour)}:${pad(w.minute)}`;
}

/** Instante → `2026-10-13T20:41:00-03:00` (usado no bloco <now> do prompt). */
export function formatLocalIso(input: string | Date, timeZone = DEFAULT_TIMEZONE): string {
  const d = toDate(input);
  const w = wallClock(d, timeZone);
  const offMin = Math.round(offsetAt(d.getTime(), timeZone) / 60000);
  const sign = offMin < 0 ? '-' : '+';
  const abs = Math.abs(offMin);
  return `${ymd(w.year, w.month, w.day)}T${pad(w.hour)}:${pad(w.minute)}:${pad(w.second)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/**
 * Data/hora vinda de uma tool: `YYYY-MM-DD` (dia contábil, ao meio-dia local) ou ISO completo.
 * Sem valor, usa `now`. Devolve o instante UTC e o dia contábil.
 */
export function resolveWhen(
  input: string | undefined,
  now: string,
  cutoffHour = DEFAULT_CUTOFF_HOUR,
  timeZone = DEFAULT_TIMEZONE,
): { at: string; localDate: string } {
  if (!input) return { at: toUtcIso(now), localDate: toLocalDate(now, cutoffHour, timeZone) };
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    parseLocalDate(input);
    return { at: toUtcIso(zonedTimeToUtc(input, 12, timeZone)), localDate: input };
  }
  // data/hora sem fuso ("2026-10-14T18:15") é hora local do usuário, não do servidor (na VM o TZ é UTC)
  const naive = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/.exec(input);
  if (naive) {
    const [, d, hh, mm, ss] = naive;
    const base = zonedTimeToUtc(d!, Number(hh), timeZone).getTime();
    const at = toUtcIso(new Date(base + Number(mm) * 60_000 + Number(ss ?? 0) * 1000));
    return { at, localDate: toLocalDate(at, cutoffHour, timeZone) };
  }
  const at = toUtcIso(input);
  return { at, localDate: toLocalDate(at, cutoffHour, timeZone) };
}
