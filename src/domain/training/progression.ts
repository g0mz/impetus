import { fmtKg, setsCompact } from './format.ts';
import type { LoadKind } from './types.ts';
import type { SetLike } from './load.ts';

export type ProgressionRule = 'increase' | 'hold' | 'deload' | 'first_time';

export type ProgressionInput = {
  /** Sessões anteriores do exercício, da mais recente para a mais antiga (só séries de trabalho importam). */
  sessions: { sets: SetLike[]; bestE1rm: number | null }[];
  repMin?: number | null;
  repMax?: number | null;
  incrementKg?: number | null;
  loadKind: LoadKind;
  /** Para a regra de deload por sono (REPORTS.md §2.4); sem dados, a condição não se aplica. */
  sleepAvgH?: number | null;
  sleepGoalH?: number | null;
};

export type ProgressionTarget = { rule: ProgressionRule; last: string; target: string; reason: string };

export const DEFAULT_REP_RANGE = { min: 8, max: 12 } as const;

/** Incremento padrão: 2 kg por mão em halteres; 2,5 kg no resto (REPORTS.md §2.4). */
export function defaultIncrement(loadKind: LoadKind): number {
  return loadKind === 'per_hand' ? 2 : 2.5;
}

/** Arredonda para o múltiplo do incremento mais próximo (para o deload de −10%). */
function roundTo(value: number, step: number): number {
  return Math.round(value / step) * step;
}

/**
 * Estagnação (REPORTS.md §2.1): nenhuma das últimas 4 sessões superou o melhor e1RM anterior a elas.
 * Exige ao menos 4 sessões cobrindo 21+ dias (o chamador garante o intervalo de datas).
 */
export function isStagnant(e1rms: (number | null)[]): boolean {
  const vals = e1rms.filter((v): v is number => v !== null);
  if (vals.length < 5) return false;
  const recent = vals.slice(0, 4);
  const before = Math.max(...vals.slice(4));
  return Math.max(...recent) <= before;
}

/**
 * Queda de e1RM > 5% em 2 sessões seguidas: as duas mais recentes ficaram mais de 5% abaixo
 * da sessão imediatamente anterior a cada uma.
 */
function droppingTwice(e1rms: (number | null)[]): boolean {
  const [a, b, c] = e1rms;
  if (a == null || b == null || c == null) return false;
  return a < b * 0.95 && b < c * 0.95;
}

/** Alvo para a próxima sessão por progressão dupla (REPORTS.md §2.4). */
export function nextTarget(input: ProgressionInput): ProgressionTarget {
  const last = input.sessions[0];
  const lastWork = (last?.sets ?? []).filter((s) => s.set_type === 'work' || s.set_type === 'failure');
  if (!last || !lastWork.length) {
    return {
      rule: 'first_time',
      last: '—',
      target: 'registre a carga de referência',
      reason: 'sem histórico',
    };
  }
  const repMin = input.repMin ?? DEFAULT_REP_RANGE.min;
  const repMax = input.repMax ?? DEFAULT_REP_RANGE.max;
  const inc = input.incrementKg ?? defaultIncrement(input.loadKind);
  const lastStr = setsCompact(lastWork);
  const topWeight = Math.max(...lastWork.map((s) => s.weight_kg ?? 0));
  const hasWeight = lastWork.some((s) => s.weight_kg !== null);
  const n = lastWork.length;
  const e1rms = input.sessions.map((s) => s.bestE1rm);

  const lowSleep = input.sleepAvgH != null && input.sleepGoalH != null && input.sleepAvgH < input.sleepGoalH;
  if (hasWeight && (droppingTwice(e1rms) || (isStagnant(e1rms) && lowSleep))) {
    const w = Math.max(roundTo(topWeight * 0.9, inc), 0);
    const reps = Math.max(...lastWork.map((s) => s.reps ?? 0));
    return {
      rule: 'deload',
      last: lastStr,
      target: `${fmtKg(w)}kg ${n}×${reps}`,
      reason: droppingTwice(e1rms)
        ? 'e1RM caiu mais de 5% em 2 sessões seguidas'
        : 'estagnação com sono abaixo da meta',
    };
  }

  const allAtMax = lastWork.every((s) => (s.reps ?? 0) >= repMax && (s.rpe == null || s.rpe <= 9));
  if (allAtMax) {
    if (!hasWeight) {
      return {
        rule: 'increase',
        last: lastStr,
        target: `${n}×${repMax + 1}`,
        reason: `todas as séries em ${repMax}+ reps`,
      };
    }
    return {
      rule: 'increase',
      last: lastStr,
      target: `${fmtKg(topWeight + inc)}kg ${n}×${repMin}`,
      reason: `todas as séries chegaram a ${repMax} reps`,
    };
  }

  // hold: mesma carga, +1 rep na série mais fraca (sem passar do topo da faixa)
  const reps = lastWork.map((s) => s.reps ?? 0);
  const weakest = reps.indexOf(Math.min(...reps));
  const targetReps = reps.map((r, i) => (i === weakest ? Math.min(r + 1, repMax) : r));
  const targetSets: SetLike[] = targetReps.map((r) => ({
    weight_kg: hasWeight ? topWeight : null,
    reps: r,
    set_type: 'work',
  }));
  return {
    rule: 'hold',
    last: lastStr,
    target: setsCompact(targetSets),
    reason: `dentro da faixa ${repMin}–${repMax}: +1 rep na série mais fraca`,
  };
}
