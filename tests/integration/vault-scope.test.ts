import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { openDb } from '../../src/db/index.ts';
import { migrate } from '../../src/db/migrate.ts';
import { callTool, createRegistry, defineTool, ok, visibleInScope } from '../../src/tools/registry.ts';

const normal = defineTool({
  name: 'normal',
  scope: 'write',
  description: 'x',
  input: z.object({}),
  handler: () => ok({ via: 'normal' }),
});
const cofre = defineTool({
  name: 'cofre',
  scope: 'write',
  group: 'vault',
  description: 'x',
  input: z.object({}),
  handler: () => ok({ via: 'cofre' }),
});
const registry = createRegistry([normal, cofre] as never);
const db = openDb(':memory:');
migrate(db);
const base = {
  db,
  now: '2026-10-30T10:00:00Z',
  turnId: null,
  settings: { cutoffHour: 4, timeZone: 'America/Sao_Paulo', openSessionHours: 3 },
};

describe('escopo vault', () => {
  it('visibleInScope separa os dois grupos', () => {
    expect(visibleInScope(normal, 'all')).toBe(true);
    expect(visibleInScope(normal, 'read')).toBe(true);
    expect(visibleInScope(normal, 'vault')).toBe(false);
    expect(visibleInScope(cofre, 'all')).toBe(false);
    expect(visibleInScope(cofre, 'vault')).toBe(true);
  });

  it('callTool recusa tool do cofre em turno de chat e tool comum em turno do cofre', () => {
    const r1 = callTool(registry, 'cofre', {}, { ...base, toolScope: 'all' });
    expect(r1.ok).toBe(false);
    const r2 = callTool(registry, 'normal', {}, { ...base, toolScope: 'vault' });
    expect(r2.ok).toBe(false);
    expect(callTool(registry, 'cofre', {}, { ...base, toolScope: 'vault' }).ok).toBe(true);
    expect(callTool(registry, 'normal', {}, { ...base, toolScope: 'all' }).ok).toBe(true);
  });
});
