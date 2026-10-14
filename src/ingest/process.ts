import type { Db } from '../db/index.ts';
import {
  markRaw,
  samplesBetween,
  upsertBodyFromHc,
  upsertDaily,
  upsertExerciseFromHc,
  upsertSample,
} from '../db/repos/health.ts';
import { getSetting, setSetting } from '../db/repos/settings.ts';
import { computeDaily, sampleLocalDate } from '../domain/health/daily.ts';
import { normalizeHcPayload } from '../domain/health/normalize-hc.ts';
import { localDayBounds } from '../time.ts';
import type { ToolSettings } from '../tools/registry.ts';

export type ProcessResult = {
  samples: number;
  body: number;
  exercises: number;
  days: string[];
  ignored: string[];
};

/** Recalcula o health_daily de um dia contábil a partir das amostras (com folga para o sono). */
export function recomputeDay(
  db: Db,
  localDate: string,
  s: Pick<ToolSettings, 'cutoffHour' | 'timeZone'>,
  now: string,
): void {
  const { start, end } = localDayBounds(localDate, s.cutoffHour, s.timeZone);
  const from = new Date(new Date(start).getTime() - 36 * 3600_000).toISOString();
  const to = new Date(new Date(end).getTime() + 12 * 3600_000).toISOString();
  upsertDaily(db, computeDaily(localDate, samplesBetween(db, from, to), s.cutoffHour, s.timeZone), now);
}

/** Normaliza um payload do HC Webhook já gravado em health_raw (ARCHITECTURE.md §4.5). Idempotente. */
export function processHealthPayload(
  db: Db,
  rawId: number,
  payload: unknown,
  s: Pick<ToolSettings, 'cutoffHour' | 'timeZone'>,
  now: string,
): ProcessResult {
  const n = normalizeHcPayload(payload);
  const days = new Set<string>();
  db.transaction(() => {
    for (const x of n.samples) {
      upsertSample(db, x, now);
      days.add(sampleLocalDate(x, s.cutoffHour, s.timeZone));
    }
    for (const b of n.body) upsertBodyFromHc(db, b, now, s.cutoffHour, s.timeZone);
    for (const e of n.exercises) upsertExerciseFromHc(db, e, now, s.cutoffHour, s.timeZone);
    for (const d of days) recomputeDay(db, d, s, now);
    markRaw(db, rawId, now, null);
  })();
  return {
    samples: n.samples.length,
    body: n.body.length,
    exercises: n.exercises.length,
    days: [...days].sort(),
    ignored: n.ignored,
  };
}

/**
 * Alerta de sync parado (REPORTS.md §1): último health_raw há mais de `hours`. Um alerta por ocorrência:
 * guarda o instante do último payload para o qual já avisou.
 */
export function hcStaleAlert(db: Db, now: string, hours: number): string | null {
  const last = db.prepare('SELECT max(received_at) FROM health_raw').pluck().get() as string | null;
  if (!last) return null; // nunca configurado: nada a alertar
  const ageH = (new Date(now).getTime() - new Date(last).getTime()) / 3600_000;
  if (ageH <= hours) return null;
  if (getSetting<string>(db, 'alert.hc_stale.sent_for') === last) return null;
  setSetting(db, 'alert.hc_stale.sent_for', last);
  return (
    `⚠️ Não recebo dados do relógio há ${Math.floor(ageH)} h. No celular: abra o HC Webhook e toque em sincronizar; ` +
    'em Configurações → Apps → Bateria, deixe Mi Fitness e HC Webhook "Sem restrições" (e ative o Início automático).'
  );
}
