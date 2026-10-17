import { describe, expect, it } from 'vitest';
import { createDashboardApp, parsePeriod } from '../../src/dashboard/http.ts';
import { createLogger } from '../../src/logger.ts';
import { seedReportWeek } from '../fixtures/report-week.ts';
import { SETTINGS, makeDb } from '../helpers.ts';

const logger = createLogger('silent');
const NOW = '2026-10-18T23:00:00Z';
const ROUTES = ['/', '/peso', '/nutricao', '/treino', '/exercicio', '/sono'];

function appWithData() {
  const { db, ex } = makeDb();
  seedReportWeek(db, { now: NOW, remada: ex.remada!, supino: ex.supInc! });
  const app = createDashboardApp({ db, settings: SETTINGS, logger, clock: () => NOW });
  return { db, app, ex };
}

describe('dashboard HTTP', () => {
  it('serve as seis rotas em HTML', async () => {
    const { app } = appWithData();
    for (const path of ROUTES) {
      const res = await app.request(`${path}?p=7d`);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
      expect(await res.text()).toContain('<html lang="pt-BR">');
    }
  });

  it('nenhuma rota escreve no banco', async () => {
    const { db, app } = appWithData();
    const audit = () => db.prepare('SELECT COALESCE(max(id),0) FROM audit_log').pluck().get();
    const settings = () =>
      db.prepare('SELECT count(*) || json_group_array(key) FROM settings').pluck().get();
    const auditBefore = audit();
    const settingsBefore = settings();

    for (const path of ROUTES) for (const p of ['7d', '30d', '90d', 'ano']) await app.request(`${path}?p=${p}`);

    expect(audit()).toBe(auditBefore);
    expect(settings()).toBe(settingsBefore);
  });

  it('período inválido cai no padrão de 30 dias', () => {
    expect(parsePeriod('bobagem', '2026-10-18').key).toBe('30d');
    expect(parsePeriod(undefined, '2026-10-18').key).toBe('30d');
    expect(parsePeriod('7d', '2026-10-18')).toEqual({
      key: '7d',
      start: '2026-10-12',
      end: '2026-10-18',
    });
    expect(parsePeriod('ano', '2026-10-18').start).toBe('2025-10-19');
  });

  it('id de exercício inválido não quebra a página', async () => {
    const { app } = appWithData();
    for (const id of ['abc', '-1', '999999', '1; DROP TABLE sets']) {
      const res = await app.request(`/exercicio?p=7d&id=${encodeURIComponent(id)}`);
      expect(res.status, id).toBe(200);
    }
  });

  it('rota desconhecida dá 404 e POST não é aceito', async () => {
    const { app } = appWithData();
    expect((await app.request('/nada')).status).toBe(404);
    expect((await app.request('/peso', { method: 'POST' })).status).toBe(404);
  });

  it('o cache serve a mesma página e solta quando o banco muda', async () => {
    const { db, app } = appWithData();
    const first = await (await app.request('/treino?p=7d')).text();
    expect(await (await app.request('/treino?p=7d')).text()).toBe(first);

    db.prepare(
      "INSERT INTO audit_log (entity, entity_id, action, created_at) VALUES ('set', 1, 'delete', ?)",
    ).run(NOW);
    db.prepare('UPDATE sets SET deleted_at = ? WHERE id = (SELECT max(id) FROM sets)').run(NOW);
    expect(await (await app.request('/treino?p=7d')).text()).not.toBe(first);
  });
});
