import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../config.ts';
import type { Db } from '../db/index.ts';
import type { RunTurn } from '../gateway/turn-runner.ts';
import type { Logger } from '../logger.ts';
import { toLocalDate } from '../time.ts';
import { e1rmSpec, setsByMuscleSpec, weightTrendSpec } from '../charts/specs.ts';
import { renderChart } from '../charts/render.ts';
import {
  buildChartData,
  buildReportBrief,
  reportPeriod,
  type ReportBrief,
  type ReportKind,
} from './build.ts';
import { renderReportFallback } from './render-fallback.ts';

export const REPORT_PROMPT_FILE = path.join(REPO_ROOT, 'runtime', 'prompts', 'report.md');

export type ReportResult = {
  reportId: number;
  text: string;
  usedLlm: boolean;
  brief: ReportBrief;
  charts: string[];
};

const KIND_PT: Record<ReportKind, string> = {
  daily: 'diário',
  weekly: 'semanal',
  monthly: 'mensal',
  adhoc: 'sob demanda',
};

/**
 * Gera um relatório (ARCHITECTURE.md §4.6): métricas e insights no código → ReportBrief salvo em `reports`
 * → turno de relatório (só tools de leitura) redige → se o cérebro falhar, fallback determinístico.
 * O relatório nunca deixa de sair.
 */
export async function generateReport(deps: {
  db: Db;
  kind: ReportKind;
  now: string;
  cutoffHour: number;
  timeZone: string;
  runTurn?: RunTurn;
  logger: Logger;
  /** Fase 5b: gera PNGs neste diretório (REPORT_CHARTS). */
  chartsDir?: string;
}): Promise<ReportResult> {
  const { db, kind, now } = deps;
  const period = reportPeriod(
    kind === 'adhoc' ? 'weekly' : kind,
    toLocalDate(now, deps.cutoffHour, deps.timeZone),
  );
  const brief = buildReportBrief(db, kind, period, now);
  const reportId = Number(
    db
      .prepare(
        `INSERT INTO reports (kind, period_start, period_end, metrics_json, insights_json, used_llm, created_at)
         VALUES (?, ?, ?, ?, ?, 0, ?)`,
      )
      .run(kind, period.start, period.end, JSON.stringify(brief), JSON.stringify(brief.insights), now)
      .lastInsertRowid,
  );

  let text = '';
  let usedLlm = false;
  if (deps.runTurn) {
    const instructions = fs.existsSync(REPORT_PROMPT_FILE) ? fs.readFileSync(REPORT_PROMPT_FILE, 'utf8') : '';
    const outcome = await deps.runTurn({
      mode: 'report',
      userText: `Redija o relatório ${KIND_PT[kind]} (${brief.period.label}). report_id=${reportId}`,
      images: [],
      inboundMessageIds: [],
      extraInstructions: instructions,
    });
    if (outcome.status === 'done' && outcome.text.trim()) {
      text = outcome.text.trim();
      usedLlm = true;
    } else
      deps.logger.warn({ reportId, status: outcome.status }, 'relatório: cérebro falhou, usando fallback');
  }
  if (!text) text = renderReportFallback(brief);
  const charts = deps.chartsDir ? await renderCharts(db, brief, deps.chartsDir, deps.logger) : [];
  db.prepare('UPDATE reports SET text = ?, used_llm = ?, chart_paths = ? WHERE id = ?').run(
    text,
    usedLlm ? 1 : 0,
    JSON.stringify(charts),
    reportId,
  );
  return { reportId, text, usedLlm, brief, charts };
}

/** Gráficos do relatório; falha de um gráfico nunca impede o relatório. */
async function renderCharts(db: Db, brief: ReportBrief, dir: string, logger: Logger): Promise<string[]> {
  const data = buildChartData(db, brief);
  const specs = [
    data.weight && weightTrendSpec(data.weight),
    data.sets_by_muscle && setsByMuscleSpec(data.sets_by_muscle),
    data.e1rm && e1rmSpec(data.e1rm),
  ].filter((x) => x !== undefined);
  const out: string[] = [];
  for (const spec of specs) {
    try {
      out.push(await renderChart(spec, dir));
    } catch (e) {
      logger.warn({ err: e }, 'relatório: falha ao gerar gráfico');
    }
  }
  return out;
}

export function markReportSent(db: Db, reportId: number, now: string): void {
  db.prepare('UPDATE reports SET sent_at = ? WHERE id = ?').run(now, reportId);
}
