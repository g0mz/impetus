import { toLocalDate } from '../../time.ts';
import type { Sample, SleepStage } from './normalize-hc.ts';

export type DailyHealth = {
  local_date: string;
  steps: number | null;
  active_kcal: number | null;
  resting_hr: number | null;
  avg_hr: number | null;
  hrv_rmssd_ms: number | null;
  sleep_minutes: number | null;
  sleep_start: string | null;
  sleep_end: string | null;
  sleep_deep_min: number | null;
  sleep_rem_min: number | null;
  sleep_light_min: number | null;
  sleep_awake_min: number | null;
};

const mid = (s: Sample) =>
  s.end_at
    ? new Date((new Date(s.start_at).getTime() + new Date(s.end_at).getTime()) / 2)
    : new Date(s.start_at);

/**
 * Dia contábil de uma amostra: intervalos pelo ponto médio; instantâneos pelo instante; sono pelo FIM da
 * sessão ("sono da noite que termina nesse dia contábil").
 */
export function sampleLocalDate(s: Sample, cutoffHour: number, tz: string): string {
  if (s.type === 'sleep_session') return toLocalDate(s.end_at ?? s.start_at, cutoffHour, tz);
  return toLocalDate(mid(s), cutoffHour, tz);
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const round = (n: number | null) => (n === null ? null : Math.round(n));

/** Agrega as amostras de um dia contábil (DATA_MODEL.md health_daily). */
export function computeDaily(
  localDate: string,
  samples: Sample[],
  cutoffHour: number,
  tz: string,
): DailyHealth {
  const day = samples.filter((s) => sampleLocalDate(s, cutoffHour, tz) === localDate);
  const of = (t: Sample['type']) => day.filter((s) => s.type === t).map((s) => s.value);
  const sum = (t: Sample['type']) => (of(t).length ? of(t).reduce((a, b) => a + b, 0) : null);

  const sleeps = day.filter((s) => s.type === 'sleep_session');
  const stages = sleeps.flatMap((s) => (s.extra as { stages?: SleepStage[] } | undefined)?.stages ?? []);
  const stageMin = (names: string[]) =>
    stages.length
      ? Math.round(stages.filter((x) => names.includes(x.stage)).reduce((t, x) => t + x.seconds, 0) / 60)
      : null;
  const main = [...sleeps].sort((a, b) => b.value - a.value)[0];
  // minutos dormidos: com estágios, exclui acordado/fora da cama; sem estágios, a duração da sessão
  const asleepMin = stages.length
    ? stageMin(['sleeping', 'light', 'deep', 'rem', 'unknown'])
    : sleeps.length
      ? Math.round(sleeps.reduce((t, s) => t + s.value, 0) / 60)
      : null;

  return {
    local_date: localDate,
    steps: round(sum('steps')),
    active_kcal: sum('active_kcal') === null ? null : Math.round(sum('active_kcal')! * 10) / 10,
    resting_hr: round(avg(of('resting_heart_rate'))),
    avg_hr: round(avg(of('heart_rate'))),
    hrv_rmssd_ms: avg(of('hrv')) === null ? null : Math.round(avg(of('hrv'))! * 10) / 10,
    sleep_minutes: asleepMin,
    sleep_start: main?.start_at ?? null,
    sleep_end: main?.end_at ?? null,
    sleep_deep_min: stageMin(['deep']),
    sleep_rem_min: stageMin(['rem']),
    sleep_light_min: stageMin(['light']),
    sleep_awake_min: stageMin(['awake', 'awake_in_bed', 'out_of_bed']),
  };
}
