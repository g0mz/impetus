import type { Db } from '../index.ts';
import type { DailyHealth } from '../../domain/health/daily.ts';
import type { ExerciseRec, Sample, WeightRec } from '../../domain/health/normalize-hc.ts';
import { toLocalDate } from '../../time.ts';

export function insertRaw(
  db: Db,
  sha256: string,
  payload: string,
  now: string,
): { id: number; duplicate: boolean } {
  const r = db
    .prepare(
      'INSERT INTO health_raw (received_at, payload_sha256, payload) VALUES (?, ?, ?) ON CONFLICT (payload_sha256) DO NOTHING',
    )
    .run(now, sha256, payload);
  if (r.changes) return { id: Number(r.lastInsertRowid), duplicate: false };
  return {
    id: db.prepare('SELECT id FROM health_raw WHERE payload_sha256 = ?').pluck().get(sha256) as number,
    duplicate: true,
  };
}

export function markRaw(db: Db, id: number, now: string, error: string | null): void {
  db.prepare('UPDATE health_raw SET processed_at = ?, error = ? WHERE id = ?').run(now, error, id);
}

/**
 * Tipos que o HC Webhook manda como acumulado "início do dia → agora", com o fim mudando a cada sync (D-032).
 */
const CUMULATIVE = new Set<Sample['type']>(['steps', 'active_kcal', 'total_kcal', 'distance']);

/**
 * Chave de idempotência: type|start|end (D-008). Nos acumulados é type|start (D-032): o bloco do dia é
 * substituído a cada sync em vez de virar outra linha e ser somado.
 */
export const sampleKey = (s: Pick<Sample, 'type' | 'start_at' | 'end_at'>) =>
  CUMULATIVE.has(s.type) ? `${s.type}|${s.start_at}` : `${s.type}|${s.start_at}|${s.end_at ?? ''}`;

/** Upsert; um payload atrasado (fim anterior ao gravado) não regride o acumulado. */
export function upsertSample(db: Db, s: Sample, now: string): void {
  db.prepare(
    `INSERT INTO health_samples (type, start_at, end_at, value, extra, external_key, created_at)
     VALUES (@type, @start_at, @end_at, @value, @extra, @key, @now)
     ON CONFLICT (external_key) DO UPDATE SET end_at = excluded.end_at, value = excluded.value,
       extra = excluded.extra, updated_at = @now
     WHERE coalesce(excluded.end_at, '') >= coalesce(health_samples.end_at, '')`,
  ).run({ ...s, extra: s.extra === undefined ? null : JSON.stringify(s.extra), key: sampleKey(s), now });
}

/** Amostras num intervalo UTC (com folga para pegar sono e intervalos que cruzam o dia). */
export function samplesBetween(db: Db, fromIso: string, toIso: string): Sample[] {
  return (
    db
      .prepare(
        'SELECT type, start_at, end_at, value, extra FROM health_samples WHERE start_at >= ? AND start_at < ?',
      )
      .all(fromIso, toIso) as (Omit<Sample, 'extra'> & { extra: string | null })[]
  ).map((r) => ({ ...r, ...(r.extra ? { extra: JSON.parse(r.extra) as unknown } : {}) }) as Sample);
}

export function upsertDaily(db: Db, d: DailyHealth, now: string): void {
  db.prepare(
    `INSERT INTO health_daily (local_date, steps, active_kcal, resting_hr, avg_hr, hrv_rmssd_ms, sleep_minutes, sleep_start, sleep_end,
                               sleep_deep_min, sleep_rem_min, sleep_light_min, sleep_awake_min, updated_at)
     VALUES (@local_date, @steps, @active_kcal, @resting_hr, @avg_hr, @hrv_rmssd_ms, @sleep_minutes, @sleep_start, @sleep_end,
             @sleep_deep_min, @sleep_rem_min, @sleep_light_min, @sleep_awake_min, @now)
     ON CONFLICT (local_date) DO UPDATE SET steps = excluded.steps, active_kcal = excluded.active_kcal,
       resting_hr = excluded.resting_hr, avg_hr = excluded.avg_hr, hrv_rmssd_ms = excluded.hrv_rmssd_ms,
       sleep_minutes = excluded.sleep_minutes, sleep_start = excluded.sleep_start, sleep_end = excluded.sleep_end,
       sleep_deep_min = excluded.sleep_deep_min, sleep_rem_min = excluded.sleep_rem_min,
       sleep_light_min = excluded.sleep_light_min, sleep_awake_min = excluded.sleep_awake_min, updated_at = excluded.updated_at`,
  ).run({ ...d, now });
}

export function upsertBodyFromHc(db: Db, b: WeightRec, now: string, cutoffHour: number, tz: string): void {
  const key = `hc|${b.weight_kg !== undefined ? 'weight' : 'body_fat'}|${b.at}`;
  db.prepare(
    `INSERT INTO body_metrics (measured_at, local_date, weight_kg, body_fat_pct, source, external_key, created_at)
     VALUES (?, ?, ?, ?, 'health_connect', ?, ?)
     ON CONFLICT (external_key) DO UPDATE SET weight_kg = excluded.weight_kg, body_fat_pct = excluded.body_fat_pct`,
  ).run(b.at, toLocalDate(b.at, cutoffHour, tz), b.weight_kg ?? null, b.body_fat_pct ?? null, key, now);
}

export function upsertExerciseFromHc(
  db: Db,
  e: ExerciseRec,
  now: string,
  cutoffHour: number,
  tz: string,
): void {
  db.prepare(
    `INSERT INTO cardio_sessions (local_date, started_at, activity, duration_s, distance_m, source, external_key, created_at)
     VALUES (?, ?, ?, ?, ?, 'health_connect', ?, ?)
     ON CONFLICT (external_key) DO UPDATE SET duration_s = excluded.duration_s, distance_m = excluded.distance_m, activity = excluded.activity`,
  ).run(
    toLocalDate(e.start, cutoffHour, tz),
    e.start,
    e.strength ? `${e.activity} (relógio)` : e.activity,
    Math.round(e.duration_s),
    e.distance_m,
    `exercise|${e.type}|${e.start}|${e.end}`,
    now,
  );
}

export function lastHealthSync(db: Db): string | null {
  return (db.prepare('SELECT max(received_at) FROM health_raw').pluck().get() as string | null) ?? null;
}
