import { createHash, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { serve, type ServerType } from '@hono/node-server';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { Hono } from 'hono';
import type { Db } from '../db/index.ts';
import type { Logger } from '../logger.ts';
import {
  callToolAsync,
  visibleInScope,
  type PrepareEnv,
  type Registry,
  type ToolScopeGrant,
  type ToolSettings,
} from '../tools/registry.ts';

export const MCP_SERVER_NAME = 'fit';

export type TurnGrant = { turnId: number; toolScope: ToolScopeGrant; now: string };

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/**
 * Tokens de turno em memória: só valem enquanto o turno roda (o turn-runner revoga ao fim).
 * Guardamos o sha256, nunca o token em claro.
 */
export function createTokenStore() {
  const grants = new Map<string, TurnGrant>();
  return {
    issue(grant: TurnGrant): { token: string; hash: string } {
      const token = randomBytes(32).toString('hex');
      const hash = hashToken(token);
      grants.set(hash, grant);
      return { token, hash };
    },
    revoke(hash: string) {
      grants.delete(hash);
    },
    resolve(token: string): TurnGrant | undefined {
      return grants.get(hashToken(token));
    },
    get size() {
      return grants.size;
    },
  };
}
export type TokenStore = ReturnType<typeof createTokenStore>;

export type McpDeps = {
  db: Db;
  registry: Registry;
  tokens: TokenStore;
  settings: ToolSettings;
  logger: Logger;
  env?: PrepareEnv;
};

function buildServer(deps: McpDeps, grant: TurnGrant): McpServer {
  const server = new McpServer({ name: MCP_SERVER_NAME, version: '0.1.0' });
  // O registry guarda schemas heterogêneos; a validação tipada acontece de novo em callTool.
  const register = server.registerTool.bind(server) as unknown as (
    name: string,
    config: { description: string; inputSchema: unknown },
    cb: (args: unknown) => Promise<{ content: { type: 'text'; text: string }[]; isError: boolean }>,
  ) => void;
  for (const def of deps.registry.values()) {
    if (!visibleInScope(def, grant.toolScope)) continue;
    register(def.name, { description: def.description, inputSchema: def.input }, async (args) => {
      const started = Date.now();
      const env = await callToolAsync(deps.registry, def.name, args, {
        db: deps.db,
        now: grant.now,
        turnId: grant.turnId,
        settings: deps.settings,
        toolScope: grant.toolScope,
        logger: deps.logger,
        ...(deps.env ? { env: deps.env } : {}),
      });
      deps.logger.info(
        {
          turnId: grant.turnId,
          tool: def.name,
          ok: env.ok,
          ms: Date.now() - started,
          ...(env.ok ? {} : { code: env.error.code }),
        },
        'tool call',
      );
      return { content: [{ type: 'text' as const, text: JSON.stringify(env) }], isError: !env.ok };
    });
  }
  return server;
}

/** App Hono do MCP: `POST /mcp` (streamable HTTP, sem estado) com `Authorization: Bearer <token de turno>`. */
export function createMcpApp(deps: McpDeps): Hono {
  const app = new Hono();
  app.all('/mcp', async (c) => {
    const auth = c.req.header('authorization') ?? '';
    const token = /^Bearer\s+(\S+)$/i.exec(auth)?.[1];
    const grant = token ? deps.tokens.resolve(token) : undefined;
    if (!grant) {
      deps.logger.warn({ path: '/mcp' }, 'mcp: token ausente ou inválido');
      return c.json({ jsonrpc: '2.0', error: { code: -32001, message: 'unauthorized' }, id: null }, 401);
    }
    const server = buildServer(deps, grant);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      await server.close();
    }
  });
  return app;
}

export type RunningMcp = { url: string; port: number; close: () => Promise<void> };

/** Sobe o MCP só em 127.0.0.1 (porta 0 = aleatória, para testes). */
export function startMcpServer(deps: McpDeps, port: number): Promise<RunningMcp> {
  const app = createMcpApp(deps);
  return new Promise((resolve) => {
    const server: ServerType = serve(
      { fetch: app.fetch, hostname: '127.0.0.1', port },
      (info: AddressInfo) => {
        resolve({
          url: `http://127.0.0.1:${info.port}/mcp`,
          port: info.port,
          close: () => new Promise<void>((r) => server.close(() => r())),
        });
      },
    );
  });
}
