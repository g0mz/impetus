import { fmtKg } from '../training/format.ts';

export type InsightCandidate = {
  id: string;
  domain: 'training' | 'nutrition' | 'body' | 'activity' | 'sleep' | 'cross' | 'system';
  severity: 'info' | 'suggestion' | 'warning' | 'celebration';
  title: string;
  evidence: Record<string, number | string>;
  n?: number;
  action?: string;
  score: number;
};

/** Contexto já calculado (números do código) que os detectores leem. */
export type InsightContext = {
  goals: { kcal?: number; protein_g?: number; steps?: number; sleep_h?: number; weight_rate_kg_wk?: number };
  prs: { exercise: string; best: string }[];
  stagnant: { exercise: string; sessions: number }[];
  setsByMuscle: Record<string, number>;
  /** Músculos com séries nas 4 semanas anteriores (histórico). */
  musclesWithHistory: string[];
  pushPull: number | null;
  workSets: number;
  /** Média semanal de séries duras nas 4 semanas anteriores. */
  workSetsAvg4w: number | null;
  nutrition: { complete_days: number; protein_adherence_pct: number | null; protein_avg: number | null };
  rateKgWk: number | null;
  maintenance: number | null;
  previousMaintenance: number | null;
  bias: { label: string; n: number; median_ratio: number }[];
  sleep: { avg_min: number | null; regularity_min: number | null; nights: number };
  sleepPerf: { insufficient_data: boolean; n: number; diff_pct?: number | null; rho?: number | null };
  steps: { steps_avg: number | null; days_with_data: number };
  rhr: { elevated: boolean; avg_14d: number | null; avg_28d: number | null };
  hcLastSync: string | null;
  now: string;
  /** Dias do período (7 no semanal, ~30 no mensal). */
  periodDays: number;
};

const SEV = { warning: 1, suggestion: 0.7, info: 0.4, celebration: 0.5 } as const;
/** Confiança pelo tamanho da amostra: satura em n = 14. */
const conf = (n: number) => Math.min(1, 0.4 + n / 14);
const clamp = (x: number) => Math.max(0, Math.min(1, x));
const score = (sev: InsightCandidate['severity'], magnitude: number, n = 14) => Math.round(SEV[sev] * clamp(magnitude) * conf(n) * 100) / 100;

export const MUSCLE_PT: Record<string, string> = {
  chest: 'peito', front_delts: 'deltoide anterior', side_delts: 'deltoide lateral', rear_delts: 'deltoide posterior',
  lats: 'dorsais', upper_back: 'costas (meio)', traps: 'trapézio', biceps: 'bíceps', triceps: 'tríceps', forearms: 'antebraço',
  quads: 'quadríceps', hamstrings: 'posteriores', glutes: 'glúteos', calves: 'panturrilhas', adductors: 'adutores',
  abductors: 'abdutores', abs: 'abdômen', obliques: 'oblíquos', lower_back: 'lombar', neck: 'pescoço',
};

type Detector = (c: InsightContext) => InsightCandidate | InsightCandidate[] | null;

export const DETECTORS: Record<string, Detector> = {
  pr_celebration: (c) =>
    c.prs.length
      ? {
          id: 'pr_celebration',
          domain: 'training',
          severity: 'celebration',
          title: `${c.prs.length} PR${c.prs.length > 1 ? 's' : ''}: ${c.prs.slice(0, 3).map((p) => `${p.exercise} ${p.best}`).join(', ')}`,
          evidence: { prs: c.prs.length },
          score: score('celebration', 1),
        }
      : null,

  stagnation: (c) =>
    c.stagnant.map((s) => ({
      id: `stagnation:${s.exercise}`,
      domain: 'training' as const,
      severity: 'suggestion' as const,
      title: `${s.exercise} sem novo recorde de e1RM nas últimas 4 sessões`,
      evidence: { sessoes: s.sessions },
      n: s.sessions,
      action: 'Varie a faixa de reps por 2–3 semanas, revise sono e proteína, ou faça uma semana de deload.',
      score: score('suggestion', 0.8, s.sessions),
    })),

  volume_imbalance: (c) => {
    const out: InsightCandidate[] = [];
    if (c.pushPull !== null && (c.pushPull < 0.7 || c.pushPull > 1.4)) {
      out.push({
        id: 'volume_imbalance:push_pull',
        domain: 'training',
        severity: 'suggestion',
        title: `Empurrar:puxar em ${String(c.pushPull).replace('.', ',')} (alvo 0,7–1,4)`,
        evidence: { push_pull: c.pushPull },
        action: c.pushPull > 1.4 ? 'Acrescente 2–4 séries de remada ou puxada por semana.' : 'Acrescente 2–4 séries de supino ou desenvolvimento por semana.',
        score: score('suggestion', Math.abs(Math.log(c.pushPull)) / Math.log(2)),
      });
    }
    const zero = c.musclesWithHistory.filter((m) => !(c.setsByMuscle[m] ?? 0) && !['neck', 'forearms', 'obliques', 'abductors', 'adductors'].includes(m));
    if (zero.length && c.workSets > 0) {
      out.push({
        id: 'volume_imbalance:zero',
        domain: 'training',
        severity: 'info',
        title: `Sem séries esta semana para: ${zero.map((m) => MUSCLE_PT[m] ?? m).join(', ')}`,
        evidence: { musculos: zero.length },
        action: 'Confira se a rotina cobre esses grupos.',
        score: score('info', Math.min(1, zero.length / 3)),
      });
    }
    return out;
  },

  volume_drop: (c) =>
    c.workSetsAvg4w && c.workSetsAvg4w > 0 && c.workSets < 0.7 * c.workSetsAvg4w
      ? {
          id: 'volume_drop',
          domain: 'training',
          severity: 'info',
          title: `Volume caiu para ${c.workSets} séries (média de 4 semanas: ${Math.round(c.workSetsAvg4w)})`,
          evidence: { semana: c.workSets, media_4s: Math.round(c.workSetsAvg4w) },
          action: 'Foi viagem, cansaço ou falta de tempo? Ajuste a rotina se for recorrente.',
          score: score('info', 1 - c.workSets / c.workSetsAvg4w),
        }
      : null,

  protein_gap: (c) =>
    c.goals.protein_g !== undefined && c.nutrition.complete_days >= 4 && c.nutrition.protein_adherence_pct !== null && c.nutrition.protein_adherence_pct < 60
      ? {
          id: 'protein_gap',
          domain: 'nutrition',
          severity: 'warning',
          title: `Meta de proteína batida em ${c.nutrition.protein_adherence_pct}% dos dias completos`,
          evidence: { aderencia_pct: c.nutrition.protein_adherence_pct, media_g: c.nutrition.protein_avg ?? 0, meta_g: c.goals.protein_g },
          n: c.nutrition.complete_days,
          action: 'Inclua uma fonte prática de proteína na refeição mais fraca (ex.: iogurte, ovos, whey).',
          score: score('warning', 1 - c.nutrition.protein_adherence_pct / 100, c.nutrition.complete_days),
        }
      : null,

  weight_rate_off: (c) => {
    const target = c.goals.weight_rate_kg_wk;
    if (target === undefined || c.rateKgWk === null || Math.abs(c.rateKgWk - target) <= 0.25) return null;
    const faster = Math.abs(c.rateKgWk) > Math.abs(target);
    return {
      id: 'weight_rate_off',
      domain: 'body',
      severity: 'suggestion',
      title: `Peso variando ${fmtKg(c.rateKgWk)} kg/sem (meta ${fmtKg(target)})`,
      evidence: { taxa: c.rateKgWk, meta: target },
      action:
        (c.rateKgWk < target ? 'Some' : 'Reduza') +
        ` ~150–250 kcal/dia${c.maintenance ? ` (manutenção estimada ~${c.maintenance} kcal)` : ''}${faster ? '' : ''}.`,
      score: score('suggestion', Math.abs(c.rateKgWk - target) / 0.75),
    };
  },

  maintenance_update: (c) =>
    c.maintenance !== null && c.previousMaintenance !== null && Math.abs(c.maintenance - c.previousMaintenance) > 150
      ? {
          id: 'maintenance_update',
          domain: 'body',
          severity: 'info',
          title: `Manutenção estimada mudou para ~${c.maintenance} kcal (antes ~${c.previousMaintenance})`,
          evidence: { atual: c.maintenance, anterior: c.previousMaintenance },
          action: 'É uma estimativa; ajuste as metas de kcal se fizer sentido.',
          score: score('info', Math.abs(c.maintenance - c.previousMaintenance) / 400),
        }
      : null,

  logging_gaps: (c) => {
    const needed = Math.min(4, Math.ceil((c.periodDays * 4) / 7));
    return c.nutrition.complete_days < needed
      ? {
          id: 'logging_gaps',
          domain: 'nutrition',
          severity: 'info',
          title: `Só ${c.nutrition.complete_days} dia(s) com registro completo de refeições`,
          evidence: { dias_completos: c.nutrition.complete_days },
          action: 'Uma foto rápida de cada refeição já basta; as médias ficam mais confiáveis.',
          score: score('info', 1 - c.nutrition.complete_days / needed),
        }
      : null;
  },

  photo_bias: (c) =>
    c.bias.map((b) => ({
      id: `photo_bias:${b.label}`,
      domain: 'nutrition' as const,
      severity: 'info' as const,
      title: `Fotos de ${b.label} têm sido superestimadas ~${Math.round((1 - b.median_ratio) * 100)}%`,
      evidence: { correcoes: b.n, razao: b.median_ratio },
      n: b.n,
      action: 'Já estou calibrando as próximas estimativas desse item.',
      score: score('info', 1 - b.median_ratio, b.n),
    })),

  sleep_short: (c) => {
    if (c.sleep.nights < 3) return null;
    const goalMin = (c.goals.sleep_h ?? 0) * 60;
    const short = c.goals.sleep_h !== undefined && c.sleep.avg_min !== null && c.sleep.avg_min < goalMin - 30;
    const irregular = c.sleep.regularity_min !== null && c.sleep.regularity_min > 60;
    if (!short && !irregular) return null;
    return {
      id: 'sleep_short',
      domain: 'sleep',
      severity: 'suggestion',
      title: short
        ? `Sono médio de ${Math.floor(c.sleep.avg_min! / 60)}h${String(Math.round(c.sleep.avg_min! % 60)).padStart(2, '0')} (meta ${c.goals.sleep_h}h)`
        : `Horário de sono irregular (±${c.sleep.regularity_min} min)`,
      evidence: { media_min: c.sleep.avg_min ?? 0, regularidade_min: c.sleep.regularity_min ?? 0 },
      n: c.sleep.nights,
      action: 'Fixe o horário de dormir e acordar, inclusive no fim de semana.',
      score: score('suggestion', short ? (goalMin - c.sleep.avg_min!) / 90 : (c.sleep.regularity_min! - 60) / 60, c.sleep.nights),
    };
  },

  sleep_performance_link: (c) =>
    !c.sleepPerf.insufficient_data && c.sleepPerf.diff_pct != null && Math.abs(c.sleepPerf.diff_pct) >= 3
      ? {
          id: 'sleep_performance_link',
          domain: 'cross',
          severity: 'info',
          title: `Após noites abaixo da meta, desempenho nos compostos ${c.sleepPerf.diff_pct < 0 ? '' : '+'}${String(c.sleepPerf.diff_pct).replace('.', ',')}% (associação, n=${c.sleepPerf.n})`,
          evidence: { diferenca_pct: c.sleepPerf.diff_pct, rho: c.sleepPerf.rho ?? 0 },
          n: c.sleepPerf.n,
          action: 'Associação, não causa: vale observar mais algumas semanas.',
          score: score('info', Math.abs(c.sleepPerf.diff_pct) / 10, c.sleepPerf.n),
        }
      : null,

  steps_below: (c) =>
    c.goals.steps !== undefined && c.steps.steps_avg !== null && c.steps.days_with_data >= 3 && c.steps.steps_avg < 0.8 * c.goals.steps
      ? {
          id: 'steps_below',
          domain: 'activity',
          severity: 'suggestion',
          title: `Média de ${c.steps.steps_avg.toLocaleString('pt-BR')} passos (meta ${c.goals.steps.toLocaleString('pt-BR')})`,
          evidence: { media: c.steps.steps_avg, meta: c.goals.steps },
          n: c.steps.days_with_data,
          action: 'Uma caminhada de 15–20 min depois do almoço cobre boa parte da diferença.',
          score: score('suggestion', 1 - c.steps.steps_avg / c.goals.steps, c.steps.days_with_data),
        }
      : null,

  rhr_elevated: (c) =>
    c.rhr.elevated
      ? {
          id: 'rhr_elevated',
          domain: 'body',
          severity: 'warning',
          title: `FC de repouso ${c.rhr.avg_14d} bpm (média de 28 dias: ${c.rhr.avg_28d})`,
          evidence: { fc_14d: c.rhr.avg_14d ?? 0, fc_28d: c.rhr.avg_28d ?? 0 },
          action: 'Pode ser cansaço acumulado; considere um dia mais leve. Não é diagnóstico.',
          score: score('warning', 0.7),
        }
      : null,

  hc_stale: (c) => {
    if (!c.hcLastSync) return null;
    const h = (Date.parse(c.now) - Date.parse(c.hcLastSync)) / 3600_000;
    return h > 48
      ? {
          id: 'hc_stale',
          domain: 'system',
          severity: 'warning',
          title: `Sem dados do relógio há ${Math.floor(h)} h`,
          evidence: { horas: Math.floor(h) },
          action: 'Abra o HC Webhook e deixe Mi Fitness e HC Webhook sem restrição de bateria.',
          score: 1,
        }
      : null;
  },
};

/** Roda todos os detectores; top 6 por score + celebrações e alertas de sistema à parte (§3). */
export function runDetectors(c: InsightContext): InsightCandidate[] {
  const all = Object.values(DETECTORS).flatMap((d) => {
    const r = d(c);
    return r === null ? [] : Array.isArray(r) ? r : [r];
  });
  const special = all.filter((i) => i.severity === 'celebration' || i.domain === 'system');
  const rest = all.filter((i) => !special.includes(i)).sort((a, b) => b.score - a.score).slice(0, 6);
  return [...special, ...rest];
}
