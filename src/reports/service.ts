import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../config.ts';
import type { Db } from '../db/index.ts';
import type { RunTurn } from '../gateway/turn-runner.ts';
import type { Logger } from '../logger.ts';
import { toLocalDate } from '../time.ts';
import { buildReportBrief, reportPeriod, type ReportBrief, type ReportKind } from './build.ts';
import { renderReportFallback } from './render-fallback.ts';

export const REPORT_PROMPT_FILE = path.join(REPO_ROOT, 'runtime', 'prompts', 'report.md');

export type ReportResult = { reportId: number; text: string; usedLlm: boolean; brief: ReportBrief };

const KIND_PT: Record<ReportKind, string> = { daily: 'diário', weekly: 'semanal', monthly: 'mensal', adhoc: 'sob demanda' };

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
}): Promise<ReportResult> {
  const { db, kind, now } = deps;
  const period = reportPeriod(kind === 'adhoc' ? 'weekly' : kind, toLocalDate(now, deps.cutoffHour, deps.timeZone));
  const brief = buildReportBrief(db, kind, period, now);
  const reportId = Number(
    db
      .prepare(
        `INSERT INTO reports (kind, period_start, period_end, metrics_json, insights_json, used_llm, created_at)
         VALUES (?, ?, ?, ?, ?, 0, ?)`,
      )
      .run(kind, period.start, period.end, JSON.stringify(brief), JSON.stringify(brief.insights), now).lastInsertRowid,
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
    } else deps.logger.warn({ reportId, status: outcome.status }, 'relatório: cérebro falhou, usando fallback');
  }
  if (!text) text = renderReportFallback(brief);
  db.prepare('UPDATE reports SET text = ?, used_llm = ? WHERE id = ?').run(text, usedLlm ? 1 : 0, reportId);
  return { reportId, text, usedLlm, brief };
}

export function markReportSent(db: Db, reportId: number, now: string): void {
  db.prepare('UPDATE reports SET sent_at = ? WHERE id = ?').run(now, reportId);
}
