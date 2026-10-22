import { describe, expect, it } from 'vitest';
import {
  exercicioPage,
  nutricaoPage,
  pesoPage,
  resumoPage,
  sonoPage,
  treinoPage,
  type PageCtx,
} from '../../src/dashboard/pages.ts';
import { trainedExercises } from '../../src/db/repos/training.ts';
import { dash } from '../../src/i18n/pt-br.ts';
import { buildReportBrief } from '../../src/reports/build.ts';
import { seedReportWeek } from '../fixtures/report-week.ts';
import { makeDb } from '../helpers.ts';

const NOW = '2026-10-18T23:00:00Z';
const CTX: PageCtx = { period: '7d', range: { start: '2026-10-12', end: '2026-10-18' }, now: NOW };

function seeded() {
  const { db, ex } = makeDb();
  seedReportWeek(db, { now: NOW, remada: ex.remada!, supino: ex.supInc! });
  return { db, ex };
}

describe('páginas do dashboard', () => {
  it('resumo mostra os números do brief, sem inventar', async () => {
    const { db } = seeded();
    const b = buildReportBrief(db, 'adhoc', CTX.range, NOW, { persist: false });
    const html = await resumoPage(db, CTX);
    expect(html).toContain(`<b>${b.training.sessions}</b>`);
    expect(html).toContain(`<b>${b.training.work_sets}</b>`);
    expect(html).toContain(`<b>${b.nutrition.kcal_avg!.toLocaleString('pt-BR')}</b>`);
  });

  it('peso traz gráfico, tendência e taxa semanal', async () => {
    const { db } = seeded();
    const b = buildReportBrief(db, 'adhoc', CTX.range, NOW, { persist: false });
    const html = await pesoPage(db, CTX);
    expect(html).toContain('<svg');
    expect(html).toContain(b.body.weight_trend_end!.toLocaleString('pt-BR'));
    expect(html).toContain('var(--dado)'); // gráfico tokenizado, não hex cravado
  });

  it('nutrição traz o gráfico com as metas e a contagem de dias', async () => {
    const { db } = seeded();
    const html = await nutricaoPage(db, CTX);
    expect(html).toContain('<svg');
    expect(html).toContain('var(--meta)'); // faixa de meta presente
    expect(html).toContain('dias registrados');
  });

  it('treino traz volume por grupo e os recordes', async () => {
    const { db } = seeded();
    const html = await treinoPage(db, CTX);
    expect(html).toContain('séries por grupo');
    expect(html).toContain('<svg');
  });

  it('exercício sem id mostra só o seletor, com os treinados no período', async () => {
    const { db } = seeded();
    const html = await exercicioPage(db, CTX);
    expect(html).toContain('<form class="seletor" method="get"');
    for (const e of trainedExercises(db, CTX.range.start, CTX.range.end)) {
      expect(html).toContain(`<option value="${e.id}"`);
    }
    expect(html).not.toContain('<svg');
  });

  it('exercício com id traz e1RM e as séries da sessão', async () => {
    const { db, ex } = seeded();
    const html = await exercicioPage(db, CTX, ex.remada!);
    expect(html).toContain('<svg');
    expect(html).toContain('selected');
    expect(html).toContain('60×8'); // carga×reps da fixture
  });

  it('sono sem dado do relógio diz o que ligar, em vez de gráfico vazio', async () => {
    const { db } = seeded();
    const html = await sonoPage(db, CTX);
    expect(html).toContain(dash.semDadosSaude);
    expect(html).not.toContain('<svg');
  });

  it('sono com passos mas sem sono mostra passos e explica o que falta', async () => {
    const { db } = seeded();
    db.prepare(
      "INSERT INTO health_daily (local_date, steps, updated_at) VALUES ('2026-10-16', 11267, '2026-10-16T23:00:00Z')",
    ).run();
    const html = await sonoPage(db, CTX);
    expect(html).toContain('Sono não está sendo enviado'); // aspas viram &quot; pelo esc
    expect(html).toContain('<svg'); // o gráfico de passos existe
    expect(html).toContain('11.267');
  });

  it('período sem nada registrado não quebra nenhuma página', async () => {
    const { db } = seeded();
    const vazio: PageCtx = { period: '7d', range: { start: '2026-01-01', end: '2026-01-07' }, now: NOW };
    for (const render of [resumoPage, pesoPage, nutricaoPage, treinoPage, sonoPage, exercicioPage]) {
      const html = await render(db, vazio);
      expect(html).toContain('<html lang="pt-BR">');
    }
  });
});
