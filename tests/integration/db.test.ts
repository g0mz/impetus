import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/db/index.ts';
import { loadMigrations, migrate } from '../../src/db/migrate.ts';
import { searchFoods, upsertFood } from '../../src/db/repos/foods.ts';

const TABLES = [
  'settings',
  'turns',
  'messages',
  'audit_log',
  'message_links',
  'exercises',
  'exercise_aliases',
  'exercises_fts',
  'routines',
  'routine_exercises',
  'workout_sessions',
  'sets',
  'cardio_sessions',
  'foods',
  'foods_fts',
  'food_portions',
  'meals',
  'meal_items',
  'meal_corrections',
  'body_metrics',
  'health_raw',
  'health_samples',
  'health_daily',
  'reports',
  'job_runs',
  'schema_migrations',
];

describe('migrations', () => {
  it('cria todo o schema do DATA_MODEL num banco vazio e é idempotente', () => {
    const db = openDb(':memory:');
    expect(migrate(db)).toEqual(loadMigrations().map((m) => m.name));
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table')")
      .pluck()
      .all() as string[];
    for (const t of TABLES) expect(names).toContain(t);
    expect(migrate(db)).toEqual([]);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('health_samples deduplica por type|start|end (D-008)', () => {
    const db = openDb(':memory:');
    migrate(db);
    const ins = db.prepare(
      `INSERT INTO health_samples (type, start_at, end_at, value, external_key, created_at)
       VALUES ('steps', '2026-10-13T10:00:00Z', '2026-10-13T11:00:00Z', ?, 'steps|2026-10-13T10:00:00Z|2026-10-13T11:00:00Z', '2026-10-13T11:00:00Z')
       ON CONFLICT (external_key) DO UPDATE SET value = excluded.value`,
    );
    ins.run(500);
    ins.run(820);
    expect(db.prepare('SELECT count(*) c, max(value) v FROM health_samples').get()).toEqual({ c: 1, v: 820 });
  });
});

describe('foods_fts (triggers)', () => {
  it('acompanha insert, update e delete', () => {
    const db = openDb(':memory:');
    migrate(db);
    const base = {
      source: 'custom' as const,
      kcal_100g: 100,
      protein_100g: 1,
      carbs_100g: 1,
      fat_100g: 1,
      is_prepared: false,
    };
    const id = upsertFood(db, { ...base, source_id: 'x1', name: 'Pão de queijo' });
    expect(searchFoods(db, 'pao queijo').map((f) => f.id)).toEqual([id]);

    upsertFood(db, { ...base, source_id: 'x1', name: 'Biscoito de polvilho' });
    expect(searchFoods(db, 'pao queijo')).toEqual([]);
    expect(searchFoods(db, 'polvilho').map((f) => f.id)).toEqual([id]);

    db.prepare('UPDATE foods SET deleted_at = ? WHERE id = ?').run('2026-10-13T00:00:00Z', id);
    expect(searchFoods(db, 'polvilho')).toEqual([]);

    db.prepare('DELETE FROM foods WHERE id = ?').run(id);
    expect(db.prepare("SELECT count(*) FROM foods_fts WHERE foods_fts MATCH 'polvilho'").pluck().get()).toBe(
      0,
    );
  });
});
