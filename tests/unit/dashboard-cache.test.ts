import { describe, expect, it } from 'vitest';
import { createPageCache } from '../../src/dashboard/cache.ts';
import { openDb } from '../../src/db/index.ts';
import { migrate } from '../../src/db/migrate.ts';

function emptyDb() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

describe('cache de página', () => {
  it('reaproveita o HTML até alguma escrita acontecer', async () => {
    const db = emptyDb();
    const cache = createPageCache(db);
    let builds = 0;
    const build = async () => `html ${++builds}`;

    expect(await cache.get('/peso?p=30d', build)).toBe('html 1');
    expect(await cache.get('/peso?p=30d', build)).toBe('html 1');
    expect(builds).toBe(1);

    db.prepare(
      "INSERT INTO audit_log (entity, entity_id, action, created_at) VALUES ('meal', 1, 'create', '2026-10-17T12:00:00Z')",
    ).run();
    expect(await cache.get('/peso?p=30d', build)).toBe('html 2');
  });

  it('escrita do relógio também invalida: ela não passa por audit_log', async () => {
    const db = emptyDb();
    const cache = createPageCache(db);
    let builds = 0;
    const build = async () => `html ${++builds}`;
    await cache.get('/sono?p=7d', build);

    db.prepare(
      "INSERT INTO health_daily (local_date, steps, updated_at) VALUES ('2026-10-17', 1513, '2026-10-17T19:00:00Z')",
    ).run();
    expect(await cache.get('/sono?p=7d', build)).toBe('html 2');
  });

  it('cada rota e período tem sua entrada', async () => {
    const db = emptyDb();
    const cache = createPageCache(db);
    let builds = 0;
    const build = async () => `html ${++builds}`;
    expect(await cache.get('/peso?p=7d', build)).toBe('html 1');
    expect(await cache.get('/peso?p=30d', build)).toBe('html 2');
    expect(await cache.get('/peso?p=7d', build)).toBe('html 1');
  });
});
