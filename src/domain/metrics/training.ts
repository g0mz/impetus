import { bestE1rm, effectiveWeight, type SetLike } from '../training/load.ts';
import type { Muscle } from '../training/muscles.ts';
import { isStagnant } from '../training/progression.ts';
import { detectPrs, type PrKind } from '../training/prs.ts';
import type { LoadKind } from '../training/types.ts';
import { mean, median, round, spearman } from './stats.ts';

export type TrainingSet = SetLike & {
  session_id: number;
  local_date: string;
  started_at: string;
  exercise_id: number;
  exercise: string;
  load_kind: LoadKind;
  is_compound: boolean;
  primary: Muscle[];
  secondary: Muscle[];
};

const isHard = (s: SetLike) => s.set_type === 'work' || s.set_type === 'failure';
const inPeriod = (s: { local_date: string }, start: string, end: string) => s.local_date >= start && s.local_date <= end;

/** Séries duras por músculo (§2.2): primário 1,0; secundário 0,5; sem aquecimento. */
export function setsByMuscle(sets: TrainingSet[]): Partial<Record<Muscle, number>> {
  const out: Partial<Record<Muscle, number>> = {};
  for (const s of sets.filter(isHard)) {
    for (const m of s.primary) out[m] = (out[m] ?? 0) + 1;
    for (const m of s.secondary) out[m] = (out[m] ?? 0) + 0.5;
  }
  return out;
}

/** Tonelagem (§2.2): Σ peso efetivo × reps das séries work. */
export function tonnage(sets: TrainingSet[], bodyweightKg: number | null): number {
  return Math.round(
    sets
      .filter((s) => s.set_type === 'work')
      .reduce((t, s) => t + (effectiveWeight(s.weight_kg, s.load_kind, bodyweightKg) ?? 0) * (s.reps ?? 0), 0),
  );
}

const PUSH: Muscle[] = ['chest', 'front_delts', 'triceps'];
const PULL: Muscle[] = ['lats', 'upper_back', 'rear_delts', 'biceps'];

/** Equilíbrio (§2.2): push:pull e quads:(posteriores + glúteos). */
export function balance(byMuscle: Partial<Record<Muscle, number>>) {
  const sum = (ms: Muscle[]) => ms.reduce((t, m) => t + (byMuscle[m] ?? 0), 0);
  const push = sum(PUSH);
  const pull = sum(PULL);
  const post = sum(['hamstrings', 'glutes']);
  return {
    push_pull: pull ? round(push / pull, 2) : null,
    quad_post: post ? round((byMuscle.quads ?? 0) / post, 2) : null,
  };
}

type Session = { session_id: number; local_date: string; started_at: string; sets: TrainingSet[] };

function sessionsOf(sets: TrainingSet[]): Session[] {
  const by = new Map<number, Session>();
  for (const s of sets) {
    const cur = by.get(s.session_id) ?? { session_id: s.session_id, local_date: s.local_date, started_at: s.started_at, sets: [] };
    cur.sets.push(s);
    by.set(s.session_id, cur);
  }
  return [...by.values()].sort((a, b) => a.started_at.localeCompare(b.started_at));
}

/** Melhor e1RM por sessão de cada exercício (série temporal). */
export function e1rmHistory(all: TrainingSet[], bodyweightKg: number | null) {
  const out = new Map<number, { exercise: string; points: { local_date: string; session_id: number; e1rm: number }[] }>();
  for (const sess of sessionsOf(all)) {
    const byEx = new Map<number, TrainingSet[]>();
    for (const s of sess.sets) byEx.set(s.exercise_id, [...(byEx.get(s.exercise_id) ?? []), s]);
    for (const [exId, xs] of byEx) {
      const e = bestE1rm(xs, xs[0]!.load_kind, bodyweightKg);
      if (e === null) continue;
      const cur = out.get(exId) ?? { exercise: xs[0]!.exercise, points: [] };
      cur.points.push({ local_date: sess.local_date, session_id: sess.session_id, e1rm: e });
      out.set(exId, cur);
    }
  }
  return out;
}

/** PRs feitos no período (cada sessão contra todo o histórico anterior a ela). */
export function prsInPeriod(all: TrainingSet[], start: string, end: string, bodyweightKg: number | null) {
  const sessions = sessionsOf(all);
  const prs: { exercise: string; kinds: PrKind[]; best: string; local_date: string }[] = [];
  sessions.forEach((sess, i) => {
    if (!inPeriod(sess, start, end)) return;
    const before = sessions.slice(0, i).flatMap((x) => x.sets);
    const exIds = [...new Set(sess.sets.map((s) => s.exercise_id))];
    for (const exId of exIds) {
      const cur = sess.sets.filter((s) => s.exercise_id === exId);
      const kinds = detectPrs(before.filter((s) => s.exercise_id === exId), cur, cur[0]!.load_kind, bodyweightKg);
      if (!kinds.length) continue;
      const top = cur.filter(isHard).sort((a, b) => (b.weight_kg ?? 0) - (a.weight_kg ?? 0) || (b.reps ?? 0) - (a.reps ?? 0))[0]!;
      prs.push({ exercise: cur[0]!.exercise, kinds, best: `${top.weight_kg ?? 'PC'}kg×${top.reps}`, local_date: sess.local_date });
    }
  });
  return prs;
}

/** Evolução de e1RM no período para os exercícios mais frequentes (compostos primeiro). */
export function topLifts(all: TrainingSet[], start: string, end: string, bodyweightKg: number | null, limit = 5) {
  const hist = e1rmHistory(all, bodyweightKg);
  const compound = new Map(all.map((s) => [s.exercise_id, s.is_compound]));
  return [...hist.entries()]
    .map(([exId, h]) => {
      const inP = h.points.filter((p) => inPeriod(p, start, end));
      const before = h.points.filter((p) => p.local_date < start).at(-1);
      const first = before ?? inP[0];
      const last = inP.at(-1);
      return { exId, exercise: h.exercise, sessions: inP.length, first, last };
    })
    .filter((x) => x.sessions > 0 && x.first && x.last)
    .sort((a, b) => Number(compound.get(b.exId)) - Number(compound.get(a.exId)) || b.sessions - a.sessions)
    .slice(0, limit)
    .map((x) => ({
      exercise: x.exercise,
      e1rm_start: round(x.first!.e1rm, 1)!,
      e1rm_end: round(x.last!.e1rm, 1)!,
      delta_pct: round(((x.last!.e1rm - x.first!.e1rm) / x.first!.e1rm) * 100, 1)!,
    }));
}

/** Exercícios estagnados (§2.1): sem novo melhor e1RM nas últimas 4 sessões, ≥ 4 sessões em 21+ dias. */
export function stagnantExercises(all: TrainingSet[], end: string, bodyweightKg: number | null) {
  const out: { exercise: string; sessions: number; best_e1rm: number }[] = [];
  for (const [, h] of e1rmHistory(all.filter((s) => s.local_date <= end), bodyweightKg)) {
    const pts = h.points;
    if (pts.length < 5) continue;
    const recent = pts.slice(-4);
    const span = (Date.parse(recent.at(-1)!.local_date) - Date.parse(recent[0]!.local_date)) / 86400_000;
    if (span < 21) continue;
    if (isStagnant(pts.map((p) => p.e1rm).reverse())) {
      out.push({ exercise: h.exercise, sessions: pts.length, best_e1rm: round(Math.max(...pts.map((p) => p.e1rm)), 1)! });
    }
  }
  return out;
}

/**
 * Índice de desempenho da sessão (§2.1): média, nos compostos, de e1RM da sessão ÷ mediana do e1RM das
 * 4 sessões anteriores do exercício − 1.
 */
export function sessionPerformance(all: TrainingSet[], bodyweightKg: number | null) {
  const hist = e1rmHistory(all.filter((s) => s.is_compound), bodyweightKg);
  const bySession = new Map<number, { local_date: string; ratios: number[] }>();
  for (const [, h] of hist) {
    h.points.forEach((p, i) => {
      const prev = h.points.slice(Math.max(0, i - 4), i).map((x) => x.e1rm);
      if (prev.length < 2) return;
      const cur = bySession.get(p.session_id) ?? { local_date: p.local_date, ratios: [] };
      cur.ratios.push(p.e1rm / median(prev)! - 1);
      bySession.set(p.session_id, cur);
    });
  }
  return [...bySession.entries()].map(([session_id, v]) => ({ session_id, local_date: v.local_date, index: mean(v.ratios)! }));
}

/**
 * Sono × desempenho (§2.7): Spearman entre o sono da noite anterior (que termina no dia da sessão) e o
 * índice da sessão. Exige n ≥ 8. Diferença média do índice entre noites < meta e ≥ meta.
 */
export function sleepVsPerformance(
  perf: { local_date: string; index: number }[],
  sleepByDate: Map<string, number>,
  goalMin: number,
) {
  const pairs = perf.filter((p) => sleepByDate.has(p.local_date)).map((p) => ({ sleep: sleepByDate.get(p.local_date)!, idx: p.index }));
  if (pairs.length < 8) return { insufficient_data: true as const, n: pairs.length };
  const short = pairs.filter((p) => p.sleep < goalMin).map((p) => p.idx);
  const ok = pairs.filter((p) => p.sleep >= goalMin).map((p) => p.idx);
  const ms = mean(short);
  const mo = mean(ok);
  return {
    insufficient_data: false as const,
    n: pairs.length,
    rho: round(spearman(pairs.map((p) => p.sleep), pairs.map((p) => p.idx)), 2),
    n_short: short.length,
    n_ok: ok.length,
    diff_pct: ms !== null && mo !== null ? round((ms - mo) * 100, 1) : null,
  };
}

export function periodTraining(all: TrainingSet[], start: string, end: string, bodyweightKg: number | null) {
  const sets = all.filter((s) => inPeriod(s, start, end));
  const byMuscle = setsByMuscle(sets);
  return {
    sessions: new Set(sets.map((s) => s.session_id)).size,
    training_days: new Set(sets.map((s) => s.local_date)).size,
    work_sets: sets.filter(isHard).length,
    tonnage_kg: tonnage(sets, bodyweightKg),
    sets_by_muscle: Object.fromEntries(Object.entries(byMuscle).map(([k, v]) => [k, round(v, 1)])) as Partial<Record<Muscle, number>>,
    ...balance(byMuscle),
  };
}
