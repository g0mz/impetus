import { renderChartSvg } from '../charts/render.ts';
import {
  e1rmWebSpec,
  kcalProteinSpec,
  setsByMuscleWebSpec,
  sleepSpec,
  stepsSpec,
  weightWebSpec,
} from '../charts/specs.ts';
import type { Db } from '../db/index.ts';
import { getGoals } from '../tools/body.ts';
import { exerciseSessions, getExercise, trainedExercises } from '../db/repos/training.ts';
import { MUSCLE_PT } from '../domain/insights/detectors.ts';
import { restingHrTrend, sleepStats, stepsStats } from '../domain/metrics/activity.ts';
import { weightTrend } from '../domain/metrics/body.ts';
import { epley } from '../domain/training/load.ts';
import { dash } from '../i18n/pt-br.ts';
import { formatDayMonth } from '../time.ts';
import {
  buildReportBrief,
  loadHealth,
  loadNutrition,
  loadWeights,
  type ReportBrief,
} from '../reports/build.ts';
import { card, esc, page, rows, stat, type PeriodKey } from './layout.ts';

export type PageCtx = { period: PeriodKey; range: { start: string; end: string }; now: string };

const num = (n: number | null | undefined, digits = 0): string =>
  n === null || n === undefined ? '—' : n.toLocaleString('pt-BR', { maximumFractionDigits: digits });

/** O brief do dashboard nunca persiste: uma página não escreve no banco. */
function brief(db: Db, ctx: PageCtx): ReportBrief {
  return buildReportBrief(db, 'adhoc', ctx.range, ctx.now, { persist: false });
}

const empty = (text: string): string => `<p class="vazio">${esc(text)}</p>`;

/** Fora da meta por mais de 10%: marca o número, sem alarmar por pouco. */
const offTarget = (value: number | null, goal: number | undefined): boolean =>
  value !== null && goal !== undefined && Math.abs(value - goal) / goal > 0.1;

export async function pesoPage(db: Db, ctx: PageCtx): Promise<string> {
  const goals = getGoals(db);
  const trend = weightTrend(loadWeights(db, ctx.range.end)).filter(
    (p) => p.local_date >= ctx.range.start,
  );
  const b = brief(db, ctx);
  const blocks: string[] = [];

  if (trend.length === 0) {
    blocks.push(card(dash.titulo.peso, empty(dash.semPeso)));
  } else {
    blocks.push(
      card(
        dash.titulo.peso,
        stat('peso', num(b.body.weight_trend_end, 1), 'kg') +
          stat('kg/semana', num(b.body.rate_kg_wk, 2)) +
          (await renderChartSvg(weightWebSpec(trend, goals.weight_target_kg))),
      ),
    );
    if (trend.length < 8) blocks.push(card('', empty(dash.poucosDados(8 - trend.length))));
    blocks.push(
      card(
        'números',
        rows([
          ['pesagens', num(b.body.weigh_ins)],
          ['manutenção estimada', `${num(b.body.maintenance_estimate)} kcal`],
          ['% do peso por semana', num(b.body.rate_pct_bw_wk, 2)],
        ]),
      ),
    );
  }
  return page({ title: dash.titulo.peso, active: 'peso', period: ctx.period, body: blocks.join('') });
}

export async function nutricaoPage(db: Db, ctx: PageCtx): Promise<string> {
  const goals = getGoals(db);
  const days = loadNutrition(db, ctx.range);
  const b = brief(db, ctx);
  const blocks: string[] = [];

  if (days.length === 0) {
    blocks.push(card(dash.titulo.nutricao, empty(dash.semRefeicoes)));
  } else {
    blocks.push(
      card(
        dash.titulo.nutricao,
        stat('kcal / dia', num(b.nutrition.kcal_avg), 'kcal', offTarget(b.nutrition.kcal_avg, goals.kcal)) +
          stat(
            'proteína / dia',
            num(b.nutrition.protein_avg),
            'g',
            offTarget(b.nutrition.protein_avg, goals.protein_g),
          ) +
          (await renderChartSvg(
            kcalProteinSpec(
              days.map((d) => ({ local_date: d.local_date, kcal: d.kcal, protein_g: d.protein_g })),
              { ...(goals.kcal ? { kcal: goals.kcal } : {}), ...(goals.protein_g ? { protein_g: goals.protein_g } : {}) },
            ),
          )),
      ),
      card(
        'registro',
        rows([
          ['dias registrados', `${num(b.nutrition.days_logged)} de ${num(b.nutrition.days_in_period)}`],
          ['dias completos', num(b.nutrition.complete_days)],
          ['qualidade do log', `${num(b.nutrition.logging_quality_pct)}%`],
          ['proteína na meta', `${num(b.nutrition.protein_days_hit)} dia(s)`],
        ]),
      ),
    );
  }
  return page({
    title: dash.titulo.nutricao,
    active: 'nutricao',
    period: ctx.period,
    body: blocks.join(''),
  });
}

export async function treinoPage(db: Db, ctx: PageCtx): Promise<string> {
  const b = brief(db, ctx);
  const blocks: string[] = [];
  const byMuscle = Object.entries(b.training.sets_by_muscle)
    .filter(([, v]) => (v ?? 0) > 0)
    .map(([m, v]) => ({ muscle: MUSCLE_PT[m] ?? m, sets: v as number }));

  if (b.training.sessions === 0) {
    blocks.push(card(dash.titulo.treino, empty(dash.semTreino)));
  } else {
    blocks.push(
      card(
        dash.titulo.treino,
        stat('sessões', num(b.training.sessions)) +
          stat('séries de trabalho', num(b.training.work_sets)) +
          stat('tonelagem', num(b.training.tonnage_kg), 'kg'),
      ),
    );
    if (byMuscle.length) {
      blocks.push(card('séries por grupo', await renderChartSvg(setsByMuscleWebSpec(byMuscle))));
    }
    if (b.training.prs.length) {
      blocks.push(
        card(
          'recordes no período',
          rows(b.training.prs.map((p) => [p.exercise, p.best])),
        ),
      );
    }
  }
  return page({ title: dash.titulo.treino, active: 'treino', period: ctx.period, body: blocks.join('') });
}

export async function exercicioPage(db: Db, ctx: PageCtx, exerciseId?: number): Promise<string> {
  const lista = trainedExercises(db, ctx.range.start, ctx.range.end);
  const options = lista
    .map(
      (e) =>
        `<option value="${e.id}"${e.id === exerciseId ? ' selected' : ''}>${esc(e.name_pt)}</option>`,
    )
    .join('');
  const seletor =
    `<form class="seletor" method="get" action="/exercicio">` +
    `<input type="hidden" name="p" value="${ctx.period}">` +
    `<select name="id" aria-label="${esc(dash.escolhaExercicio)}">` +
    `<option value="">${esc(dash.escolhaExercicio)}</option>${options}</select>` +
    `<button type="submit">${esc(dash.verTodos)}</button></form>`;

  const blocks: string[] = [seletor];
  if (lista.length === 0) {
    blocks.push(card(dash.titulo.exercicio, empty(dash.semTreino)));
  } else if (exerciseId !== undefined) {
    const ex = getExercise(db, exerciseId);
    const sessions = exerciseSessions(db, exerciseId, 200)
      .filter((s) => s.local_date >= ctx.range.start && s.local_date <= ctx.range.end)
      .reverse();
    const points = sessions
      .map((s) => {
        const best = s.sets
          .filter((x) => x.weight_kg !== null && x.reps !== null)
          .map((x) => epley(x.weight_kg!, x.reps!))
          .reduce<number | null>((a, e) => (e !== null && (a === null || e > a) ? e : a), null);
        return best === null ? null : { local_date: s.local_date, e1rm: Math.round(best * 10) / 10 };
      })
      .filter((p): p is { local_date: string; e1rm: number } => p !== null);

    blocks.push(
      card(
        ex?.name_pt ?? dash.titulo.exercicio,
        points.length
          ? await renderChartSvg(e1rmWebSpec(points))
          : empty(dash.semTreino),
      ),
      card(
        'sessões',
        rows(
          sessions
            .slice()
            .reverse()
            .map((s) => [
              formatDayMonth(s.local_date),
              s.sets
                .filter((x) => x.reps !== null)
                .map((x) => `${x.weight_kg ?? 0}×${x.reps}`)
                .join('  '),
            ]),
        ),
      ),
    );
  }
  return page({
    title: dash.titulo.exercicio,
    active: 'exercicio',
    period: ctx.period,
    body: blocks.join(''),
  });
}

export async function sonoPage(db: Db, ctx: PageCtx): Promise<string> {
  const goals = getGoals(db);
  const days = loadHealth(db, ctx.range.start, ctx.range.end);
  const steps = stepsStats(days, goals.steps);
  const sleep = sleepStats(days, goals.sleep_h);
  const hr = restingHrTrend(days);
  const blocks: string[] = [];

  if (steps.days_with_data === 0 && sleep.nights === 0) {
    blocks.push(card(dash.titulo.sono, empty(dash.semDadosSaude)));
  } else {
    const noites = days
      .filter((d) => d.sleep_minutes !== null && d.sleep_minutes !== undefined)
      .map((d) => ({ local_date: d.local_date, hours: Math.round((d.sleep_minutes! / 60) * 10) / 10 }));
    blocks.push(
      card(
        'sono',
        noites.length
          ? stat('horas / noite', num(sleep.avg_min === null ? null : sleep.avg_min / 60, 1), 'h') +
              (await renderChartSvg(sleepSpec(noites, goals.sleep_h)))
          : empty(dash.semSono),
      ),
    );
    if (steps.days_with_data > 0) {
      const passos = days
        .filter((d) => d.steps !== null && d.steps !== undefined)
        .map((d) => ({ local_date: d.local_date, steps: d.steps! }));
      blocks.push(
        card(
          'passos',
          stat('passos / dia', num(steps.steps_avg)) +
            (await renderChartSvg(stepsSpec(passos, goals.steps))),
        ),
      );
    }
    if (hr.avg_14d !== null) {
      blocks.push(
        card(
          'coração',
          rows([
            ['FC de repouso (14 d)', `${num(hr.avg_14d)} bpm`],
            ['FC de repouso (28 d)', `${num(hr.avg_28d)} bpm`],
          ]),
        ),
      );
    }
  }
  return page({ title: dash.titulo.sono, active: 'sono', period: ctx.period, body: blocks.join('') });
}

export async function resumoPage(db: Db, ctx: PageCtx): Promise<string> {
  const goals = getGoals(db);
  const b = brief(db, ctx);
  const days = loadHealth(db, ctx.range.start, ctx.range.end);
  const steps = stepsStats(days, goals.steps);
  const sleep = sleepStats(days, goals.sleep_h);

  const body = [
    card(
      dash.titulo.peso,
      stat('peso', num(b.body.weight_trend_end, 1), 'kg') +
        stat('kg/semana', num(b.body.rate_kg_wk, 2)),
    ),
    card(
      dash.titulo.nutricao,
      stat('kcal / dia', num(b.nutrition.kcal_avg), 'kcal', offTarget(b.nutrition.kcal_avg, goals.kcal)) +
        stat(
          'proteína / dia',
          num(b.nutrition.protein_avg),
          'g',
          offTarget(b.nutrition.protein_avg, goals.protein_g),
        ),
    ),
    card(
      dash.titulo.treino,
      stat('sessões', num(b.training.sessions)) + stat('séries', num(b.training.work_sets)),
    ),
    card(
      dash.titulo.sono,
      steps.days_with_data === 0 && sleep.nights === 0
        ? empty(dash.semDadosSaude)
        : stat('passos / dia', num(steps.steps_avg)) +
            (sleep.nights ? stat('horas / noite', num(sleep.avg_min === null ? null : sleep.avg_min / 60, 1), 'h') : ''),
    ),
  ].join('');

  return page({ title: dash.titulo.resumo, active: 'resumo', period: ctx.period, body, path: '/' });
}
