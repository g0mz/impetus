import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeDaily, sampleLocalDate } from '../../src/domain/health/daily.ts';
import { exerciseInfo, normalizeHcPayload, sleepStageName } from '../../src/domain/health/normalize-hc.ts';
import { createIngestApp } from '../../src/ingest/http.ts';
import { hcStaleAlert } from '../../src/ingest/process.ts';
import { createLogger } from '../../src/logger.ts';
import { SETTINGS, data, makeCaller, makeDb } from '../helpers.ts';

const FIXTURE = fs.readFileSync(path.join(import.meta.dirname, '..', 'fixtures', 'hc_sample.json'), 'utf8');
const KEY = 'k'.repeat(64);
const S = { cutoffHour: 4, timeZone: 'America/Sao_Paulo' };

function setup(clock = '2026-10-13T12:05:00Z') {
  const { db } = makeDb();
  const app = createIngestApp({
    db,
    apiKey: KEY,
    settings: S,
    logger: createLogger('silent'),
    clock: () => clock,
  });
  const post = (body: string, headers: Record<string, string> = { 'x-api-key': KEY }) =>
    app.request('/ingest/health', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
    });
  return { db, app, post };
}

describe('normalização do HC Webhook', () => {
  it('estágios do sono: inteiro do AndroidX ou nome', () => {
    expect(['0', '1', '2', '3', '4', '5', '6', '7'].map(sleepStageName)).toEqual([
      'unknown',
      'awake',
      'sleeping',
      'out_of_bed',
      'light',
      'deep',
      'rem',
      'awake_in_bed',
    ]);
    expect(sleepStageName('deep')).toBe('deep');
    expect(sleepStageName('STAGE_TYPE_REM')).toBe('rem');
    expect(sleepStageName('xyz')).toBe('unknown');
  });

  it('tipos de exercício (constantes do AndroidX)', () => {
    expect(exerciseInfo('56')).toEqual({ activity: 'corrida', strength: false });
    expect(exerciseInfo('70')).toEqual({ activity: 'musculação', strength: true });
    expect(exerciseInfo('running')).toEqual({ activity: 'corrida', strength: false });
    expect(exerciseInfo('999').activity).toBe('exercício (999)');
  });

  it('converte o fixture e ignora tipos fora do escopo', () => {
    const n = normalizeHcPayload(JSON.parse(FIXTURE));
    expect(n.samples.filter((s) => s.type === 'steps')).toHaveLength(2);
    const sleep = n.samples.find((s) => s.type === 'sleep_session')!;
    expect(sleep).toMatchObject({
      start_at: '2026-10-13T02:30:00Z',
      end_at: '2026-10-13T10:00:00Z',
      value: 27000,
    });
    expect(n.body).toEqual([
      { at: '2026-10-13T10:30:00Z', weight_kg: 74.2 },
      { at: '2026-10-13T10:30:00Z', body_fat_pct: 17.8 },
    ]);
    expect(n.exercises.map((e) => [e.activity, e.strength])).toEqual([
      ['corrida', false],
      ['musculação', true],
    ]);
    expect(n.ignored).toEqual(['_comment', 'menstruation_flow']);
  });
});

describe('agregado diário', () => {
  const sleepEnding = (end: string, durH = 7) => ({
    type: 'sleep_session' as const,
    start_at: new Date(new Date(end).getTime() - durH * 3600_000).toISOString(),
    end_at: end,
    value: durH * 3600,
  });

  it('sono que termina às 07:00 conta no próprio dia; às 03:30, no dia anterior', () => {
    expect(sampleLocalDate(sleepEnding('2026-10-13T10:00:00Z'), 4, S.timeZone)).toBe('2026-10-13'); // 07:00 local
    expect(sampleLocalDate(sleepEnding('2026-10-13T06:30:00Z', 2), 4, S.timeZone)).toBe('2026-10-12'); // 03:30 local
  });

  it('minutos de sono excluem acordado; estágios somados', () => {
    const n = normalizeHcPayload(JSON.parse(FIXTURE));
    const d = computeDaily('2026-10-13', n.samples, 4, S.timeZone);
    expect(d).toMatchObject({
      steps: 5000,
      sleep_minutes: 430, // 450 − 20 acordado
      sleep_light_min: 240,
      sleep_deep_min: 90,
      sleep_rem_min: 100,
      sleep_awake_min: 20,
      resting_hr: 56,
      avg_hr: 72,
      hrv_rmssd_ms: 48.5,
      active_kcal: 210.4,
    });
  });
});

describe('POST /ingest/health', () => {
  it('autenticação, JSON inválido, limite de 1 MB e /healthz', async () => {
    const g = setup();
    expect((await g.post(FIXTURE, {})).status).toBe(401);
    expect((await g.post(FIXTURE, { 'x-api-key': 'errada' })).status).toBe(401);
    expect((await g.post('{oops')).status).toBe(400);
    expect((await g.post(JSON.stringify({ x: 'a'.repeat(1024 * 1024 + 10) }))).status).toBe(413);
    expect(await (await g.app.request('/healthz')).json()).toMatchObject({ ok: true });
  });

  it('payload do botão "Test Webhook" (test: true) só confirma conexão: nada é gravado', async () => {
    const g = setup();
    const body = JSON.stringify({ ...JSON.parse(FIXTURE), test: true });
    expect(await (await g.post(body)).json()).toEqual({ ok: true, test: true });
    await g.app.drain();
    const count = (t: string) => g.db.prepare(`SELECT count(*) FROM ${t}`).pluck().get();
    expect([count('health_raw'), count('health_samples'), count('body_metrics')]).toEqual([0, 0, 0]);
  });

  it('reenvio do mesmo payload não duplica nada; get_day_summary mostra passos e sono', async () => {
    const g = setup();
    expect(await (await g.post(FIXTURE)).json()).toEqual({ ok: true, duplicate: false });
    expect(await (await g.post(FIXTURE)).json()).toEqual({ ok: true, duplicate: true });
    await g.app.drain();
    const count = (t: string) => g.db.prepare(`SELECT count(*) FROM ${t}`).pluck().get();
    expect([
      count('health_raw'),
      count('health_samples'),
      count('body_metrics'),
      count('cardio_sessions'),
    ]).toEqual([1, 8, 2, 2]);
    expect(g.db.prepare('SELECT processed_at, error FROM health_raw').get()).toEqual({
      processed_at: '2026-10-13T12:05:00Z',
      error: null,
    });

    const { call } = makeCaller(g.db, { now: '2026-10-13T15:00:00Z' });
    const day = data(
      call<{ health: { steps: number; sleep_minutes: number; resting_hr: number } }>('get_day_summary', {}),
    );
    expect(day.health).toMatchObject({ steps: 5000, sleep_minutes: 430, resting_hr: 56 });
    const range = data(
      call<{ days: Record<string, unknown>[] }>('get_health_range', {
        from: '2026-10-12',
        to: '2026-10-13',
        fields: ['sleep', 'weight'],
      }),
    );
    expect(range.days).toEqual([
      {
        local_date: '2026-10-13',
        sleep_minutes: 430,
        sleep_deep_min: 90,
        sleep_rem_min: 100,
        sleep_light_min: 240,
        sleep_awake_min: 20,
        weight_kg: 74.2,
      },
    ]);
  });

  it('payload novo com o mesmo intervalo atualiza o valor (D-008), sem somar em dobro', async () => {
    const g = setup();
    const p = (count: number) =>
      JSON.stringify({
        timestamp: `t${count}`,
        app_version: '1',
        steps: [{ count, start_time: '2026-10-13T10:00:00Z', end_time: '2026-10-13T11:00:00Z' }],
      });
    await g.post(p(500));
    await g.post(p(820));
    await g.app.drain();
    expect(g.db.prepare("SELECT steps FROM health_daily WHERE local_date = '2026-10-13'").pluck().get()).toBe(
      820,
    );
  });

  it('rate limit de 60 req/min', async () => {
    const g = setup();
    let last = 0;
    for (let i = 0; i < 61; i++) last = (await g.post('{}', {})).status;
    expect(last).toBe(429);
  });
});

describe('alerta hc_stale', () => {
  it('dispara uma vez por ocorrência após 48 h sem dados', async () => {
    const g = setup('2026-10-10T12:00:00Z');
    expect(hcStaleAlert(g.db, '2026-10-13T12:00:00Z', 48)).toBeNull(); // nunca recebeu nada
    await g.post(FIXTURE);
    await g.app.drain();
    expect(hcStaleAlert(g.db, '2026-10-11T12:00:00Z', 48)).toBeNull();
    expect(hcStaleAlert(g.db, '2026-10-13T12:00:00Z', 48)).toMatch(/há 72 h/);
    expect(hcStaleAlert(g.db, '2026-10-13T18:00:00Z', 48)).toBeNull(); // já avisou
    void SETTINGS;
  });
});
