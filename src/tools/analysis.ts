import { z } from 'zod';
import type { Db } from '../db/index.ts';
import { weightTrend, trendAt } from '../domain/metrics/body.ts';
import { addDays, resolveWhen } from '../time.ts';
import { defineTool, err, ok } from './registry.ts';

export const getReportBriefTool = defineTool({
  name: 'get_report_brief',
  scope: 'read',
  description:
    'ReportBrief já calculado (métricas + candidatos de insight) de um relatório. Use SOMENTE os números daqui ao redigir.',
  input: z.object({ report_id: z.number().int().positive() }),
  handler: (ctx, { report_id }) => {
    const row = ctx.db.prepare('SELECT metrics_json FROM reports WHERE id = ?').pluck().get(report_id) as
      string | undefined;
    if (!row) return err('NOT_FOUND', `relatório ${report_id} não existe`);
    return ok(JSON.parse(row) as unknown);
  },
});

/** Tendência (α = 0,1) e variação de 7 dias após registrar um peso. */
export function weightSnapshot(db: Db, localDate: string) {
  const weights = db
    .prepare(
      `SELECT local_date, weight_kg FROM body_metrics b1 WHERE weight_kg IS NOT NULL AND deleted_at IS NULL AND local_date <= ?
         AND measured_at = (SELECT max(measured_at) FROM body_metrics b2 WHERE b2.local_date = b1.local_date AND b2.weight_kg IS NOT NULL AND b2.deleted_at IS NULL)
       ORDER BY local_date`,
    )
    .all(localDate) as { local_date: string; weight_kg: number }[];
  const trend = weightTrend(weights);
  const now = trendAt(trend, localDate);
  const before = trendAt(trend, addDays(localDate, -7));
  return {
    weight_trend_kg: now === null ? null : Math.round(now * 10) / 10,
    delta_7d_kg: now !== null && before !== null ? Math.round((now - before) * 10) / 10 : null,
    weigh_ins: weights.length,
  };
}

export const logBodyMetricTool = defineTool({
  name: 'log_body_metric',
  scope: 'write',
  description:
    'Registra peso, % de gordura ou cintura ("pesei 74,2"). Responda com a TENDÊNCIA devolvida, não só o valor do dia.',
  input: z
    .object({
      weight_kg: z.number().min(25).max(350).optional(),
      body_fat_pct: z.number().min(2).max(70).optional(),
      waist_cm: z.number().min(40).max(250).optional(),
      measured_at: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}(T.+)?$/)
        .optional(),
    })
    .refine(
      (v) => v.weight_kg !== undefined || v.body_fat_pct !== undefined || v.waist_cm !== undefined,
      'informe uma medida',
    ),
  handler: (ctx, input) => {
    const { at, localDate } = resolveWhen(
      input.measured_at,
      ctx.now,
      ctx.settings.cutoffHour,
      ctx.settings.timeZone,
    );
    const id = Number(
      ctx.db
        .prepare(
          `INSERT INTO body_metrics (measured_at, local_date, weight_kg, body_fat_pct, waist_cm, source, created_at)
           VALUES (?, ?, ?, ?, ?, 'chat', ?)`,
        )
        .run(
          at,
          localDate,
          input.weight_kg ?? null,
          input.body_fat_pct ?? null,
          input.waist_cm ?? null,
          ctx.now,
        ).lastInsertRowid,
    );
    ctx.audit('body_metric', id, 'create');
    return ok({ id, local_date: localDate, ...weightSnapshot(ctx.db, localDate) });
  },
});

export const analysisTools = [getReportBriefTool, logBodyMetricTool];
