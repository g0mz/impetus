import { mean, median, round, sd } from './stats.ts';

export type HealthDay = {
  local_date: string;
  steps: number | null;
  sleep_minutes: number | null;
  sleep_start: string | null;
  sleep_end: string | null;
  resting_hr: number | null;
};

export function stepsStats(days: HealthDay[], goal?: number) {
  const s = days.map((d) => d.steps).filter((x): x is number => x !== null);
  return {
    days_with_data: s.length,
    steps_avg: round(mean(s)),
    steps_median: round(median(s)),
    steps_days_hit: goal !== undefined ? s.filter((x) => x >= goal).length : null,
  };
}

/** Ponto médio do sono em minutos do relógio local, centrado à meia-noite (−720..720). */
export function sleepMidpointMinutes(start: string, end: string, tzOffsetMin: number): number {
  const midUtc = (Date.parse(start) + Date.parse(end)) / 2;
  const local = new Date(midUtc + tzOffsetMin * 60_000);
  let m = local.getUTCHours() * 60 + local.getUTCMinutes();
  if (m > 720) m -= 1440;
  return m;
}

/** Sono (§2.6): média, regularidade (DP do ponto médio, min) e noites abaixo da meta. */
export function sleepStats(days: HealthDay[], goalH?: number, tzOffsetMin = -180) {
  const withSleep = days.filter((d) => d.sleep_minutes !== null);
  const mids = withSleep
    .filter((d) => d.sleep_start && d.sleep_end)
    .map((d) => sleepMidpointMinutes(d.sleep_start!, d.sleep_end!, tzOffsetMin));
  return {
    nights: withSleep.length,
    avg_min: round(mean(withSleep.map((d) => d.sleep_minutes!))),
    regularity_min: round(sd(mids)),
    days_below_goal:
      goalH !== undefined ? withSleep.filter((d) => d.sleep_minutes! < goalH * 60).length : null,
  };
}

/** FC de repouso (§2.6): média de 14 dias vs. 28 dias; alta sustentada ≥ 5 bpm é sinal (sem diagnóstico). */
export function restingHrTrend(days: HealthDay[]) {
  const sorted = days
    .filter((d) => d.resting_hr !== null)
    .sort((a, b) => a.local_date.localeCompare(b.local_date));
  const last = (n: number) => mean(sorted.slice(-n).map((d) => d.resting_hr!));
  const a14 = last(14);
  const a28 = last(28);
  return {
    avg_14d: round(a14, 1),
    avg_28d: round(a28, 1),
    elevated: a14 !== null && a28 !== null && sorted.length >= 21 && a14 - a28 >= 5,
  };
}
