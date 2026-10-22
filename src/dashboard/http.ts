import type { AddressInfo } from 'node:net';
import { serve, type ServerType } from '@hono/node-server';
import { Hono } from 'hono';
import type { Db } from '../db/index.ts';
import type { Logger } from '../logger.ts';
import { addDays, nowUtcIso, toLocalDate } from '../time.ts';
import type { ToolSettings } from '../tools/registry.ts';
import { createPageCache } from './cache.ts';
import { PERIODS, type PeriodKey } from './layout.ts';
import {
  exercicioPage,
  nutricaoPage,
  pesoPage,
  resumoPage,
  sonoPage,
  treinoPage,
  type PageCtx,
} from './pages.ts';

const DAYS: Record<PeriodKey, number> = { '7d': 7, '30d': 30, '90d': 90, ano: 365 };

/** Recorte pedido na querystring. Valor estranho cai no padrão de 30 dias, sem erro na cara. */
export function parsePeriod(
  p: string | undefined,
  today: string,
): { key: PeriodKey; start: string; end: string } {
  const key = (PERIODS as string[]).includes(p ?? '') ? (p as PeriodKey) : '30d';
  return { key, start: addDays(today, -(DAYS[key] - 1)), end: today };
}

export type DashboardDeps = {
  db: Db;
  settings: Pick<ToolSettings, 'cutoffHour' | 'timeZone'>;
  logger: Logger;
  clock?: () => string;
};

/**
 * Dashboard somente leitura (DEPLOY.md §6): seis páginas `GET`, zero JavaScript, nenhuma escrita.
 * Escuta só em 127.0.0.1; quem atravessa é o `tailscale serve`.
 */
export function createDashboardApp(deps: DashboardDeps) {
  const clock = deps.clock ?? nowUtcIso;
  const cache = createPageCache(deps.db);
  const app = new Hono();

  const ctxOf = (p: string | undefined): PageCtx => {
    const now = clock();
    const today = toLocalDate(now, deps.settings.cutoffHour, deps.settings.timeZone);
    const { key, start, end } = parsePeriod(p, today);
    return { period: key, range: { start, end }, now };
  };

  const simple: [string, (db: Db, ctx: PageCtx) => Promise<string>][] = [
    ['/', resumoPage],
    ['/peso', pesoPage],
    ['/nutricao', nutricaoPage],
    ['/treino', treinoPage],
    ['/sono', sonoPage],
  ];
  for (const [path, build] of simple) {
    app.get(path, async (c) => {
      const ctx = ctxOf(c.req.query('p'));
      const html = await cache.get(`${path}?p=${ctx.period}`, () => build(deps.db, ctx));
      return c.html(html);
    });
  }
  app.get('/exercicio', async (c) => {
    const ctx = ctxOf(c.req.query('p'));
    const raw = c.req.query('id');
    const id = raw && /^\d+$/.test(raw) ? Number(raw) : undefined;
    const html = await cache.get(`/exercicio?p=${ctx.period}&id=${id ?? ''}`, () =>
      exercicioPage(deps.db, ctx, id),
    );
    return c.html(html);
  });

  return app;
}

export type RunningDashboard = { url: string; port: number; close: () => Promise<void> };

/** Sobe o dashboard só em 127.0.0.1, como a ingestão. */
export function startDashboardServer(
  app: ReturnType<typeof createDashboardApp>,
  port: number,
): Promise<RunningDashboard> {
  return new Promise((resolve) => {
    const server: ServerType = serve({ fetch: app.fetch, hostname: '127.0.0.1', port }, (info: AddressInfo) =>
      resolve({
        url: `http://127.0.0.1:${info.port}`,
        port: info.port,
        close: () => new Promise<void>((r) => server.close(() => r())),
      }),
    );
  });
}
