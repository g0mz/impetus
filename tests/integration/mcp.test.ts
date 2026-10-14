import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTurn } from '../../src/db/repos/turns.ts';
import { createLogger } from '../../src/logger.ts';
import { createTokenStore, startMcpServer, type RunningMcp } from '../../src/mcp/server.ts';
import { buildRegistry } from '../../src/tools/index.ts';
import { SETTINGS, makeDb } from '../helpers.ts';

const { db, ex } = makeDb();
const tokens = createTokenStore();
let mcp: RunningMcp;

beforeAll(async () => {
  mcp = await startMcpServer(
    { db, registry: buildRegistry(), tokens, settings: SETTINGS, logger: createLogger('silent') },
    0,
  );
});
afterAll(() => mcp.close());

async function connect(token: string) {
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(mcp.url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

const parse = (r: unknown) =>
  JSON.parse((r as { content: { text: string }[] }).content[0]!.text) as Record<string, unknown>;

describe('servidor MCP (streamable HTTP, token de turno)', () => {
  it('escuta só em 127.0.0.1', () => {
    expect(mcp.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  });

  it('recusa sem token ou com token inválido (401)', async () => {
    const res = await fetch(mcp.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
    await expect(connect('f'.repeat(64))).rejects.toThrow();
  });

  it('lista as tools e executa com o turn_id do token (auditoria)', async () => {
    const turnId = createTurn(db, 'chat');
    const { token, hash } = tokens.issue({ turnId, toolScope: 'all', now: '2026-10-13T21:00:00Z' });
    const client = await connect(token);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(['search_exercises', 'log_workout', 'get_next_targets', 'set_goal']),
    );

    const r = parse(
      await client.callTool({
        name: 'log_workout',
        arguments: { entries: [{ exercise_id: ex.remada, sets: [{ weight_kg: 60, reps: 8 }] }] },
      }),
    );
    expect(r).toMatchObject({ ok: true, data: { session_totals: { work_sets: 1 } } });
    expect(db.prepare('SELECT count(*) FROM audit_log WHERE turn_id = ?').pluck().get(turnId)).toBe(2);
    await client.close();

    tokens.revoke(hash);
    await expect(connect(token)).rejects.toThrow(); // token expira ao fim do turno
  });

  it('turno somente leitura recebe FORBIDDEN em escrita', async () => {
    const turnId = createTurn(db, 'report');
    const { token, hash } = tokens.issue({ turnId, toolScope: 'read', now: '2026-10-13T21:00:00Z' });
    const client = await connect(token);
    const r = await client.callTool({ name: 'set_goal', arguments: { key: 'kcal', value: 2000 } });
    expect(r.isError).toBe(true);
    expect(parse(r)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    await client.close();
    tokens.revoke(hash);
  });
});
