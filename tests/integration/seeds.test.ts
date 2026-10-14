import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/index.ts';
import { migrate } from '../../src/db/migrate.ts';
import { countExercises, searchExercises } from '../../src/db/repos/exercises.ts';
import { countFoods, searchFoods } from '../../src/db/repos/foods.ts';
import { SEEDS_DIR, runSeeds, type SeedReport } from '../../src/seeds/index.ts';
import { verifyVendor } from '../../src/seeds/vendor.ts';

let db: Db;
let report: SeedReport;

beforeAll(() => {
  db = openDb(':memory:');
  migrate(db);
  report = runSeeds(db);
});

describe('seed TACO', () => {
  // 597 itens; 6 sem energia na fonte oficial (* = em reavaliação; NA no sal) ficam de fora.
  it('importa a TACO 4ª ed. sem inventar valores ausentes', () => {
    expect(report.taco.inserted).toBe(591);
    expect(report.taco.skipped.map((s) => s.id)).toEqual(['450', '457', '458', '516', '517', '591']);
    expect(countFoods(db, 'taco')).toBe(591);
  });

  // Valores conferidos no PDF oficial da TACO 4ª ed. (NEPA/Unicamp, 2011),
  // taco_4_edicao_ampliada_e_revisada.pdf (sha256 2002aec5…), Tabela 1. Página = página do PDF.
  const OFFICIAL = [
    { id: '3', name: 'Arroz, tipo 1, cozido', page: 29, kcal: 128, p: 2.5, f: 0.2, c: 28.1, fiber: 1.6 },
    { id: '53', name: 'Pão, trigo, francês', page: 31, kcal: 300, p: 8.0, f: 3.1, c: 58.6, fiber: 2.3 },
    { id: '182', name: 'Banana, prata, crua', page: 39, kcal: 98, p: 1.3, f: 0.1, c: 26.0, fiber: 2.0 },
    {
      id: '410',
      name: 'Frango, peito, sem pele, grelhado',
      page: 55,
      kcal: 159,
      p: 32.0,
      f: 2.5,
      c: 0.0,
      fiber: null,
    },
    { id: '561', name: 'Feijão, carioca, cozido', page: 65, kcal: 76, p: 4.8, f: 0.5, c: 13.6, fiber: 8.5 },
  ];

  it.each(OFFICIAL)('$name confere com a tabela oficial (p. $page)', (o) => {
    const row = db
      .prepare(
        `SELECT name, kcal_100g kcal, protein_100g p, fat_100g f, carbs_100g c, fiber_100g fiber, is_prepared
           FROM foods WHERE source = 'taco' AND source_id = ?`,
      )
      .get(o.id) as Record<string, unknown>;
    expect(row).toMatchObject({ name: o.name, kcal: o.kcal, p: o.p, f: o.f, c: o.c, fiber: o.fiber });
  });

  it('óleo (proteína e carboidrato NA na fonte) entra com 0 g', () => {
    const oil = db
      .prepare(
        "SELECT protein_100g p, carbs_100g c, fat_100g f FROM foods WHERE source='taco' AND source_id='259'",
      )
      .get();
    expect(oil).toEqual({ p: 0, c: 0, f: 100 });
  });

  it('search_foods("arroz cozido") traz arroz cozido, com o tipo 1 no topo', () => {
    const r = searchFoods(db, 'arroz cozido');
    expect(r.length).toBeGreaterThan(0);
    expect(r.slice(0, 3).map((f) => f.name)).toContain('Arroz, tipo 1, cozido');
    for (const f of r) expect(f.name).toMatch(/arroz.*cozid/i);
    expect(r.every((f) => f.is_prepared)).toBe(true);
  });

  it('filtra por preparado', () => {
    const raw = searchFoods(db, 'arroz', { prepared: false, limit: 10 });
    expect(raw.map((f) => f.name)).toContain('Arroz, tipo 1, cru');
    expect(raw.some((f) => /cozid/.test(f.name))).toBe(false);
    expect(searchFoods(db, 'arroz', { prepared: true, limit: 10 }).every((f) => f.is_prepared)).toBe(true);
  });
});

describe('seed de exercícios', () => {
  it('importa o free-exercise-db inteiro e aplica o CSV PT-BR', () => {
    expect(report.exercises.imported).toBe(876);
    expect(report.exercises.translated).toBeGreaterThanOrEqual(80);
    expect(countExercises(db)).toBe(report.exercises.imported + report.exercises.custom);
  });

  it('search_exercises("sup inc") acha o supino inclinado pelo apelido', () => {
    const r = searchExercises(db, 'sup inc');
    expect(r[0]).toMatchObject({
      name_pt: 'Supino inclinado com barra',
      equipment: 'barbell',
      load_kind: 'total',
      score: 1,
    });
    expect(r.map((e) => e.name_pt)).toContain('Supino inclinado com halteres');
  });

  it('acha por apelido com acento e por prefixo', () => {
    expect(searchExercises(db, 'Elevação lateral')[0]?.name_pt).toBe('Elevação lateral com halteres');
    expect(searchExercises(db, 'supino inclinado halter')[0]?.name_pt).toBe('Supino inclinado com halteres');
    expect(searchExercises(db, 'extensora')[0]?.name_pt).toBe('Cadeira extensora');
    // palavra exata antes de prefixo: "supino" não traz "Puxada supinada" entre os primeiros
    expect(
      searchExercises(db, 'supino')
        .slice(0, 5)
        .map((e) => e.name_pt)
        .every((n) => n.startsWith('Supino')),
    ).toBe(true);
  });

  it('halteres são por mão e músculos do CSV substituem a heurística', () => {
    const row = db
      .prepare(
        "SELECT load_kind, primary_muscles, increment_kg FROM exercises WHERE name_pt = 'Elevação lateral com halteres'",
      )
      .get();
    expect(row).toEqual({ load_kind: 'per_hand', primary_muscles: '["side_delts"]', increment_kg: 1 });
  });
});

describe('seed de medidas caseiras (IBGE)', () => {
  it('carrega só valores conferidos, com procedência', () => {
    expect(report.portions).toBe(84);
    const row = db
      .prepare(
        "SELECT grams, source_ref FROM food_portions WHERE food_name = 'Arroz (polido, parboilizado)' AND label = 'colher de sopa cheia'",
      )
      .get() as { grams: number; source_ref: string };
    expect(row.grams).toBe(25);
    expect(row.source_ref).toMatch(/liv50000\.pdf\) p\.35;/);
  });
});

describe('idempotência e integridade', () => {
  it('rodar os seeds de novo não duplica nada', () => {
    const before = {
      foods: countFoods(db),
      ex: countExercises(db),
      aliases: db.prepare('SELECT count(*) FROM exercise_aliases').pluck().get(),
      portions: db.prepare('SELECT count(*) FROM food_portions').pluck().get(),
    };
    const again = runSeeds(db);
    expect(again.exercises.aliases).toBe(0);
    expect({
      foods: countFoods(db),
      ex: countExercises(db),
      aliases: db.prepare('SELECT count(*) FROM exercise_aliases').pluck().get(),
      portions: db.prepare('SELECT count(*) FROM food_portions').pluck().get(),
    }).toEqual(before);
    expect(searchExercises(db, 'sup inc')[0]?.name_pt).toBe('Supino inclinado com barra');
  });

  it('recusa dados versionados alterados (manifest)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'impetus-seeds-'));
    fs.cpSync(SEEDS_DIR, tmp, { recursive: true });
    expect(() => verifyVendor(tmp)).not.toThrow();
    fs.appendFileSync(path.join(tmp, 'vendor/taco/nutrients.csv'), '999,1,1,1,1,1,,1,1,1\n');
    expect(() => verifyVendor(tmp)).toThrow(/nutrients\.csv: sha256/);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
