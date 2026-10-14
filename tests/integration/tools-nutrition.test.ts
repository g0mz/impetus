import { describe, expect, it } from 'vitest';
import { insertPortion, upsertFood } from '../../src/db/repos/foods.ts';
import { undoTurn } from '../../src/db/undo.ts';
import { parseOffProduct } from '../../src/tools/nutrition.ts';
import { buildRegistry } from '../../src/tools/index.ts';
import { callToolAsync } from '../../src/tools/registry.ts';
import { SETTINGS, data, makeCaller, makeDb } from '../helpers.ts';

type MealOut = {
  meal_id: number;
  local_date: string;
  meal_type: string;
  items: {
    item_id: number;
    label: string;
    grams: number;
    range?: string;
    origin: string;
    kcal: number;
    protein_g: number;
  }[];
  totals: { kcal: number; protein_g: number; carbs_g: number; fat_g: number };
  confidence: string;
  pending_question?: string;
  day: {
    kcal: number;
    protein_g: number;
    goals?: { protein_g?: number };
    remaining?: { protein_g?: number };
  };
};

/** Fixture com valores da TACO 4ª ed. (por 100 g). */
function setup(now = '2026-10-13T16:00:00Z') {
  const { db } = makeDb();
  const f = (
    source_id: string,
    name: string,
    kcal: number,
    p: number,
    c: number,
    fat: number,
    fiber: number | null,
  ) =>
    upsertFood(db, {
      source: 'taco',
      source_id,
      name,
      kcal_100g: kcal,
      protein_100g: p,
      carbs_100g: c,
      fat_100g: fat,
      fiber_100g: fiber,
      is_prepared: true,
    });
  const foods = {
    arroz: f('3', 'Arroz, tipo 1, cozido', 128, 2.5, 28.1, 0.2, 1.6),
    feijao: f('561', 'Feijão, carioca, cozido', 76, 4.8, 13.6, 0.5, 8.5),
    frango: f('410', 'Frango, peito, sem pele, grelhado', 159, 32, 0, 2.5, null),
    oleo: f('269', 'Óleo, de soja', 884, 0, 0, 100, null),
  };
  insertPortion(db, {
    food_id: null,
    food_name: 'Feijão (preto, mulatinho, roxo, rosinha, etc.)',
    label: 'concha média cheia',
    grams: 140,
    source: 'ibge',
    source_ref: null,
  });
  insertPortion(db, {
    food_id: null,
    food_name: 'Arroz (polido, parboilizado)',
    label: 'colher de sopa cheia',
    grams: 25,
    source: 'ibge',
    source_ref: null,
  });
  return { db, foods, ...makeCaller(db, { now }) };
}

const almoco = (foods: Record<string, number>) => ({
  user_text: 'almoço, frango foi 150g',
  items: [
    {
      label: 'Frango grelhado',
      food_id: foods.frango,
      grams: 150,
      origin: 'user_stated',
      confidence: 'high',
    },
    {
      label: 'Arroz branco',
      food_id: foods.arroz,
      grams: 140,
      grams_low: 120,
      grams_high: 170,
      origin: 'photo_estimate',
      confidence: 'medium',
    },
    {
      label: 'Feijão carioca',
      food_id: foods.feijao,
      grams: 100,
      grams_low: 80,
      grams_high: 130,
      origin: 'photo_estimate',
      confidence: 'medium',
    },
    {
      label: 'Óleo de preparo',
      food_id: foods.oleo,
      grams: 8,
      grams_low: 4,
      grams_high: 12,
      origin: 'text_estimate',
      confidence: 'low',
    },
  ],
  assumptions: ['óleo de preparo estimado em 8 g'],
});

describe('log_meal', () => {
  it('calcula macros por item, totais, confiança, tipo pelo horário e totais do dia', () => {
    const g = setup();
    data(g.call('set_goal', { key: 'protein_g', value: 150 }));
    const m = data(g.call<MealOut>('log_meal', almoco(g.foods)));
    // 150 g frango 238,5 + 140 g arroz 179,2 + 100 g feijão 76 + 8 g óleo 70,7 = 564,4
    expect(m.totals).toEqual({ kcal: 564, protein_g: 56, carbs_g: 53, fat_g: 13, fiber_g: 11 });
    expect(m.items.map((i) => [i.label, i.grams, i.range ?? null, i.kcal])).toEqual([
      ['Frango grelhado', 150, null, 239],
      ['Arroz branco', 140, '120–170', 179],
      ['Feijão carioca', 100, '80–130', 76],
      ['Óleo de preparo', 10, '5–10', 71],
    ]);
    expect(m.meal_type).toBe('almoco'); // 13:00 local
    expect(m.confidence).toBe('medium');
    expect(m.day).toMatchObject({
      kcal: 564,
      protein_g: 56,
      goals: { protein_g: 150 },
      remaining: { protein_g: 94 },
    });
  });

  it('validações: gramas fora da faixa, alimento inexistente, item sem food_id nem override', () => {
    const g = setup();
    const it = (x: object) => ({ items: [{ label: 'x', origin: 'text_estimate', confidence: 'low', ...x }] });
    expect(g.call('log_meal', it({ food_id: g.foods.arroz, grams: 3000 }))).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION' },
    });
    expect(g.call('log_meal', it({ food_id: 9999, grams: 100 }))).toMatchObject({
      ok: false,
      error: { code: 'NOT_FOUND' },
    });
    expect(g.call('log_meal', it({ grams: 100 }))).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION' },
    });
    expect(g.db.prepare('SELECT count(*) FROM meals').pluck().get()).toBe(0);
  });

  it('macros_override (prato sem match) e aviso de total incomum', () => {
    const g = setup();
    const r = g.call<MealOut>('log_meal', {
      items: [
        {
          label: 'Feijoada completa',
          grams: 1500,
          macros_override: { kcal: 3300, protein_g: 150, carbs_g: 200, fat_g: 200 },
          origin: 'text_estimate',
          confidence: 'low',
        },
      ],
    });
    expect(r.ok && r.hints).toEqual(['total incomum, confirme com o usuário']);
    expect(r.ok && r.data.totals.kcal).toBe(3300);
  });

  it('ontem à noite conta no dia contábil certo', () => {
    const g = setup();
    const m = data(
      g.call<MealOut>('log_meal', {
        eaten_at: '2026-10-12',
        meal_type: 'jantar',
        items: [
          { label: 'Arroz', food_id: g.foods.arroz, grams: 100, origin: 'user_stated', confidence: 'high' },
        ],
      }),
    );
    expect(m.local_date).toBe('2026-10-12');
  });
});

describe('correções e aprendizado', () => {
  it('update_meal_item corrige gramas, grava meal_corrections, vira prior e /desfazer reverte', () => {
    const g = setup();
    const m = data(g.call<MealOut>('log_meal', almoco(g.foods)));
    const arrozId = m.items[1]!.item_id;
    g.newTurn();
    const fixed = data(g.call<{ meal: MealOut }>('update_meal_item', { meal_item_id: arrozId, grams: 100 }));
    expect(fixed.meal.items[1]).toMatchObject({ grams: 100, origin: 'corrected', kcal: 128 });
    expect(fixed.meal.totals.kcal).toBe(513);
    expect(g.db.prepare('SELECT field, old_value, new_value FROM meal_corrections').get()).toEqual({
      field: 'grams',
      old_value: '140',
      new_value: '100',
    });

    // corrigido e informado alimentam os priors (n ≥ 2)
    g.newTurn();
    data(
      g.call('log_meal', {
        items: [
          {
            label: 'arroz branco',
            food_id: g.foods.arroz,
            grams: 120,
            origin: 'user_stated',
            confidence: 'high',
          },
        ],
      }),
    );
    const pri = data(
      g.call<{ priors: { label: string; n: number; median_g: number }[] }>('get_food_priors', {
        labels: ['Arroz branco'],
      }),
    );
    expect(pri.priors).toEqual([expect.objectContaining({ label: 'arroz branco', n: 2, median_g: 110 })]);

    undoTurn(g.db, g.state.turnId); // desfaz só o turno da 2ª refeição
    const after = g.db.prepare('SELECT grams, origin FROM meal_items WHERE id = ?').get(arrozId);
    expect(after).toEqual({ grams: 100, origin: 'corrected' }); // a correção (outro turno) continua
  });

  it('desfazer a correção restaura o item e os totais', () => {
    const g = setup();
    const m = data(g.call<MealOut>('log_meal', almoco(g.foods)));
    const t2 = g.newTurn();
    data(g.call('update_meal_item', { meal_item_id: m.items[3]!.item_id, delete: true }));
    expect(g.db.prepare('SELECT round(kcal) FROM meals WHERE id = ?').pluck().get(m.meal_id)).toBe(494);
    undoTurn(g.db, t2);
    expect(g.db.prepare('SELECT round(kcal) FROM meals WHERE id = ?').pluck().get(m.meal_id)).toBe(564);
    expect(g.db.prepare('SELECT count(*) FROM meal_corrections').pluck().get()).toBe(0);
  });

  it('add_meal_item e update_meal (pergunta pendente, tipo)', () => {
    const g = setup();
    const m = data(
      g.call<MealOut>('log_meal', {
        ...almoco(g.foods),
        pending_question: 'A carne é contrafilé ou patinho?',
      }),
    );
    expect(m.pending_question).toMatch(/patinho/);
    const added = data(
      g.call<{ meal: MealOut }>('add_meal_item', {
        meal_id: m.meal_id,
        item: {
          label: 'Arroz extra',
          food_id: g.foods.arroz,
          grams: 50,
          origin: 'user_stated',
          confidence: 'high',
        },
      }),
    );
    expect(added.meal.items).toHaveLength(5);
    const upd = data(
      g.call<{ meal: MealOut }>('update_meal', {
        meal_id: m.meal_id,
        clear_pending_question: true,
        meal_type: 'jantar',
      }),
    );
    expect(upd.meal.pending_question).toBeUndefined();
    expect(upd.meal.meal_type).toBe('jantar');
    expect(g.call('update_meal', { meal_id: 999, delete: true })).toMatchObject({
      ok: false,
      error: { code: 'NOT_FOUND' },
    });
  });
});

describe('busca, medidas e alimentos personalizados', () => {
  it('search_foods em lote e get_portions por texto', () => {
    const g = setup();
    const r = data(
      g.call<{ results: { query: string; foods: { name: string }[] }[] }>('search_foods', {
        queries: ['arroz cozido', 'frango grelhado'],
      }),
    );
    expect(r.results.map((x) => x.foods[0]?.name)).toEqual([
      'Arroz, tipo 1, cozido',
      'Frango, peito, sem pele, grelhado',
    ]);
    const p = data(
      g.call<{ results: { portions: { label: string; grams: number }[] }[] }>('get_portions', {
        queries: ['concha feijão', 'colher de sopa arroz'],
      }),
    );
    expect(p.results.map((x) => x.portions[0])).toEqual([
      expect.objectContaining({ label: 'concha média cheia', grams: 140 }),
      expect.objectContaining({ label: 'colher de sopa cheia', grams: 25 }),
    ]);
  });

  it('create_custom_food por porção ("meu whey") cria porção nomeada e atualiza pelo nome', () => {
    const g = setup();
    const w = data(
      g.call<{ food_id: number; per_100g: { protein_g: number } }>('create_custom_food', {
        name: 'Meu whey',
        per_portion: { grams: 30, kcal: 120, protein_g: 24, carbs_g: 3, fat_g: 1.5 },
        portion_label: 'scoop',
      }),
    );
    expect(w.per_100g.protein_g).toBe(80);
    const p = data(
      g.call<{ portions: { label: string; grams: number; food: string }[] }>('get_portions', {
        query: 'scoop whey',
      }),
    );
    expect(p.portions[0]).toEqual({ label: 'scoop', grams: 30, food: 'Meu whey', source: 'label' });
    const again = data(
      g.call<{ food_id: number; updated: boolean }>('create_custom_food', {
        name: 'meu whey',
        per_100g: { kcal: 380, protein_g: 75, carbs_g: 10, fat_g: 5 },
      }),
    );
    expect(again).toMatchObject({ food_id: w.food_id, updated: true });
    expect(
      g.call('create_custom_food', {
        name: 'x',
        per_100g: { kcal: 1, protein_g: 90, carbs_g: 90, fat_g: 0 },
      }),
    ).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
  });

  it('lookup_barcode: importa da Open Food Facts (fetch injetado) e reaproveita depois', async () => {
    const g = setup();
    const registry = buildRegistry();
    let calls = 0;
    const fakeFetch = (async (url: string) => {
      calls++;
      expect(url).toContain('/api/v2/product/7891000100103.json');
      return new Response(
        JSON.stringify({
          status: 1,
          product: {
            product_name: 'Leite integral',
            brands: 'Marca X',
            nutriments: {
              'energy-kcal_100g': 60,
              proteins_100g: 3.1,
              carbohydrates_100g: 4.6,
              fat_100g: 3.2,
              sodium_100g: 0.05,
            },
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const base = {
      db: g.db,
      now: g.state.now,
      turnId: g.state.turnId,
      settings: SETTINGS,
      toolScope: 'all' as const,
      env: { fetch: fakeFetch, userAgent: 'test' },
    };
    const r = await callToolAsync(registry, 'lookup_barcode', { ean: '7891000100103' }, base);
    expect(r).toMatchObject({
      ok: true,
      data: { found: true, food: { name: 'Leite integral', brand: 'Marca X', kcal_100g: 60 } },
    });
    expect(g.db.prepare("SELECT sodium_mg_100g FROM foods WHERE source = 'off'").pluck().get()).toBe(50);
    const again = await callToolAsync(registry, 'lookup_barcode', { ean: '7891000100103' }, base);
    expect(again).toMatchObject({ ok: true, data: { found: true } });
    expect(calls).toBe(2); // prepare roda, mas o handler usa o que já está no banco

    const off = await callToolAsync(
      registry,
      'lookup_barcode',
      { ean: '0000000000000' },
      {
        ...base,
        env: {
          fetch: (async () => {
            throw new Error('rede');
          }) as unknown as typeof fetch,
          userAgent: 't',
        },
      },
    );
    expect(off).toMatchObject({
      ok: true,
      data: { found: false },
      hints: [expect.stringMatching(/indisponível/)],
    });
  });

  it('parseOffProduct: kJ → kcal e produto incompleto', () => {
    expect(
      parseOffProduct({
        status: 1,
        product: {
          product_name: 'X',
          nutriments: { energy_100g: 418.4, proteins_100g: 1, carbohydrates_100g: 1, fat_100g: 1 },
        },
      }),
    ).toMatchObject({ found: true, food: { kcal: 100 } });
    expect(parseOffProduct({ status: 1, product: { product_name: 'X', nutriments: {} } })).toMatchObject({
      found: false,
    });
    expect(parseOffProduct({ status: 0 })).toMatchObject({ found: false });
  });
});
