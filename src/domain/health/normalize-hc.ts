// Normalização do payload JSON do HC Webhook (mcnaveen/health-connect-webhook, docs/webhook.md) para o
// modelo do Impetus (DATA_MODEL.md §4). Pura: recebe o JSON, devolve registros. Tipos não listados
// (ciclo menstrual, atividade sexual, glicose…) são ignorados — ficam só no health_raw.

export type SampleType =
  | 'steps'
  | 'heart_rate'
  | 'resting_heart_rate'
  | 'hrv'
  | 'active_kcal'
  | 'total_kcal'
  | 'distance'
  | 'spo2'
  | 'sleep_session';

export type SleepStageName =
  'awake' | 'sleeping' | 'out_of_bed' | 'light' | 'deep' | 'rem' | 'awake_in_bed' | 'unknown';
export type SleepStage = { stage: SleepStageName; start: string; end: string; seconds: number };

export type Sample = {
  type: SampleType;
  start_at: string;
  end_at: string | null;
  value: number;
  extra?: unknown;
};
export type WeightRec = { at: string; weight_kg?: number; body_fat_pct?: number };
export type ExerciseRec = {
  type: string;
  activity: string;
  strength: boolean;
  start: string;
  end: string;
  duration_s: number;
  distance_m: number | null;
};

export type Normalized = {
  samples: Sample[];
  body: WeightRec[];
  exercises: ExerciseRec[];
  ignored: string[];
};

/**
 * Estágios do sono: o app envia `stage.toString()` do AndroidX (inteiro como texto, ex. "5");
 * o payload de teste do app usa nomes ("deep"). Constantes de SleepSessionRecord.STAGE_TYPE_*.
 */
const STAGE_BY_INT: Record<string, SleepStageName> = {
  '0': 'unknown',
  '1': 'awake',
  '2': 'sleeping',
  '3': 'out_of_bed',
  '4': 'light',
  '5': 'deep',
  '6': 'rem',
  '7': 'awake_in_bed',
};

export function sleepStageName(raw: unknown): SleepStageName {
  const s = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (STAGE_BY_INT[s]) return STAGE_BY_INT[s]!;
  const bare = s.replace(/^stage_type_/, '');
  const known: SleepStageName[] = ['awake', 'sleeping', 'out_of_bed', 'light', 'deep', 'rem', 'awake_in_bed'];
  return (known as string[]).includes(bare) ? (bare as SleepStageName) : 'unknown';
}

/** ExerciseSessionRecord.EXERCISE_TYPE_* (AndroidX) → nome PT-BR; força vira só referência de duração. */
const EXERCISE: Record<string, { pt: string; strength?: true }> = {
  '0': { pt: 'treino' },
  '8': { pt: 'bike' },
  '9': { pt: 'bike ergométrica' },
  '13': { pt: 'calistenia', strength: true },
  '16': { pt: 'dança' },
  '25': { pt: 'elíptico' },
  '36': { pt: 'HIIT' },
  '37': { pt: 'trilha' },
  '48': { pt: 'pilates' },
  '54': { pt: 'remo ergômetro' },
  '56': { pt: 'corrida' },
  '57': { pt: 'esteira' },
  '64': { pt: 'futebol' },
  '68': { pt: 'escada' },
  '69': { pt: 'simulador de escada' },
  '70': { pt: 'musculação', strength: true },
  '71': { pt: 'alongamento' },
  '73': { pt: 'natação (águas abertas)' },
  '74': { pt: 'natação' },
  '79': { pt: 'caminhada' },
  '81': { pt: 'musculação', strength: true },
  '83': { pt: 'yoga' },
};
const EXERCISE_BY_NAME: Record<string, string> = {
  running: '56',
  walking: '79',
  biking: '8',
  strength_training: '70',
  weightlifting: '81',
  running_treadmill: '57',
  biking_stationary: '9',
  elliptical: '25',
};

export function exerciseInfo(raw: unknown): { activity: string; strength: boolean } {
  const s = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/^exercise_type_/, '');
  const key = EXERCISE[s] ? s : EXERCISE_BY_NAME[s];
  const info = key ? EXERCISE[key] : undefined;
  return info
    ? { activity: info.pt, strength: Boolean(info.strength) }
    : { activity: `exercício (${s || '?'})`, strength: false };
}

const iso = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().replace(/\.\d{3}Z$/, 'Z');
};
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const arr = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? (v as Record<string, unknown>[]) : [];

const KNOWN = new Set([
  'timestamp',
  'app_version',
  'steps',
  'sleep',
  'heart_rate',
  'resting_heart_rate',
  'heart_rate_variability',
  'active_calories',
  'total_calories',
  'distance',
  'oxygen_saturation',
  'weight',
  'body_fat',
  'exercise',
]);

export function normalizeHcPayload(payload: unknown): Normalized {
  const p = (payload ?? {}) as Record<string, unknown>;
  const out: Normalized = {
    samples: [],
    body: [],
    exercises: [],
    ignored: Object.keys(p).filter((k) => !KNOWN.has(k)),
  };

  const interval = (key: string, type: SampleType, field: string) => {
    for (const r of arr(p[key])) {
      const s = iso(r.start_time);
      const e = iso(r.end_time);
      const v = num(r[field]);
      if (s && e && v !== null) out.samples.push({ type, start_at: s, end_at: e, value: v });
    }
  };
  /** Instantâneo: amostra ou agregado de N minutos (avg/min/max; o campo legado = avg). */
  const instant = (key: string, type: SampleType, field: string) => {
    for (const r of arr(p[key])) {
      const t = iso(r.time);
      const v = num(r.avg) ?? num(r[field]);
      if (!t || v === null) continue;
      const agg = num(r.avg) !== null;
      out.samples.push({
        type,
        start_at: t,
        end_at: null,
        value: v,
        ...(agg ? { extra: { min: r.min, max: r.max } } : {}),
      });
    }
  };

  interval('steps', 'steps', 'count');
  interval('active_calories', 'active_kcal', 'calories');
  interval('total_calories', 'total_kcal', 'calories');
  interval('distance', 'distance', 'meters');
  instant('heart_rate', 'heart_rate', 'bpm');
  instant('resting_heart_rate', 'resting_heart_rate', 'bpm');
  instant('heart_rate_variability', 'hrv', 'rmssd_millis');
  instant('oxygen_saturation', 'spo2', 'percentage');

  for (const r of arr(p.sleep)) {
    const end = iso(r.session_end_time);
    const dur = num(r.duration_seconds);
    if (!end || dur === null || dur <= 0) continue;
    const start = new Date(new Date(end).getTime() - dur * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const stages: SleepStage[] = arr(r.stages).flatMap((st) => {
      const s = iso(st.start_time);
      const e = iso(st.end_time);
      const secs =
        num(st.duration_seconds) ?? (s && e ? (new Date(e).getTime() - new Date(s).getTime()) / 1000 : null);
      return s && e && secs !== null
        ? [{ stage: sleepStageName(st.stage), start: s, end: e, seconds: secs }]
        : [];
    });
    out.samples.push({ type: 'sleep_session', start_at: start, end_at: end, value: dur, extra: { stages } });
  }

  for (const r of arr(p.weight)) {
    const t = iso(r.time);
    const kg = num(r.kilograms);
    if (t && kg !== null && kg > 20 && kg < 400) out.body.push({ at: t, weight_kg: kg });
  }
  for (const r of arr(p.body_fat)) {
    const t = iso(r.time);
    const pct = num(r.percentage);
    if (t && pct !== null && pct > 1 && pct < 80) out.body.push({ at: t, body_fat_pct: pct });
  }
  for (const r of arr(p.exercise)) {
    const s = iso(r.start_time);
    const e = iso(r.end_time);
    if (!s || !e) continue;
    const info = exerciseInfo(r.type);
    out.exercises.push({
      type: String(r.type),
      ...info,
      start: s,
      end: e,
      duration_s: num(r.duration_seconds) ?? (new Date(e).getTime() - new Date(s).getTime()) / 1000,
      distance_m: num(r.distance_meters),
    });
  }
  return out;
}
