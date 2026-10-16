import { createHash, timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { serve, type ServerType } from '@hono/node-server';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import PQueue from 'p-queue';
import type { Db } from '../db/index.ts';
import { insertRaw, markRaw } from '../db/repos/health.ts';
import type { Logger } from '../logger.ts';
import { nowUtcIso } from '../time.ts';
import type { ToolSettings } from '../tools/registry.ts';
import { processHealthPayload } from './process.ts';

export const MAX_BODY_BYTES = 1024 * 1024;
export const RATE_LIMIT_PER_MIN = 60;

export type IngestDeps = {
  db: Db;
  apiKey: string | undefined;
  settings: Pick<ToolSettings, 'cutoffHour' | 'timeZone'>;
  logger: Logger;
  clock?: () => string;
};

function sameKey(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * Ingestão do HC Webhook (ARCHITECTURE.md §4.5): `POST /ingest/health` com `X-Api-Key`, até 1 MB,
 * 60 req/min. Grava o bruto (dedupe por SHA-256), responde 200 rápido e normaliza numa fila interna.
 * `GET /healthz` para monitoração.
 */
export function createIngestApp(deps: IngestDeps) {
  const clock = deps.clock ?? nowUtcIso;
  const app = new Hono();
  const queue = new PQueue({ concurrency: 1 });
  let windowStart = 0;
  let windowCount = 0;

  app.get('/healthz', (c) => {
    deps.db.prepare('SELECT 1').get();
    return c.json({ ok: true, time: clock() });
  });

  app.post(
    '/ingest/health',
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => c.json({ ok: false, error: 'payload acima de 1 MB' }, 413),
    }),
    async (c) => {
      const now = Date.now();
      if (now - windowStart > 60_000) {
        windowStart = now;
        windowCount = 0;
      }
      if (++windowCount > RATE_LIMIT_PER_MIN) return c.json({ ok: false, error: 'rate limit' }, 429);

      const key = c.req.header('x-api-key');
      if (!deps.apiKey || !key || !sameKey(key, deps.apiKey)) {
        deps.logger.warn('ingest: X-Api-Key ausente ou inválida');
        return c.json({ ok: false, error: 'unauthorized' }, 401);
      }
      const raw = await c.req.text();
      let payload: unknown;
      try {
        payload = JSON.parse(raw);
      } catch {
        return c.json({ ok: false, error: 'JSON inválido' }, 400);
      }
      // O botão "Test Webhook" do app manda dados fictícios com `test: true`: só confirma conexão e chave.
      if ((payload as { test?: unknown } | null)?.test === true) {
        deps.logger.info('ingest: payload de teste recebido (descartado)');
        return c.json({ ok: true, test: true });
      }
      const sha = createHash('sha256').update(raw).digest('hex');
      const { id, duplicate } = insertRaw(deps.db, sha, raw, clock());
      if (!duplicate) {
        void queue.add(() => {
          try {
            const r = processHealthPayload(deps.db, id, payload, deps.settings, clock());
            deps.logger.info({ rawId: id, ...r }, 'ingest: payload processado');
          } catch (e) {
            markRaw(deps.db, id, clock(), String(e).slice(0, 500));
            deps.logger.error({ err: e, rawId: id }, 'ingest: falha ao normalizar');
          }
        });
      }
      return c.json({ ok: true, duplicate });
    },
  );

  return Object.assign(app, { drain: () => queue.onIdle() });
}

export type RunningIngest = { url: string; port: number; close: () => Promise<void> };

/** Sobe a ingestão só em 127.0.0.1 (exposta via Tailscale Serve ou Caddy; DEPLOY.md §6). */
export function startIngestServer(
  app: ReturnType<typeof createIngestApp>,
  port: number,
): Promise<RunningIngest> {
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
