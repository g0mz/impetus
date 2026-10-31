import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/db/index.ts';
import { migrate } from '../../src/db/migrate.ts';
import { lastTurnWithPendingWrites } from '../../src/db/repos/audit.ts';
import { createTurn } from '../../src/db/repos/turns.ts';
import { buildRegistry } from '../../src/tools/index.ts';
import { callTool } from '../../src/tools/registry.ts';
import { parseNote, resolveNotePath } from '../../src/vault/notes.ts';

const registry = buildRegistry();
const mk = (max = 10) => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-tools-'));
  const db = openDb(':memory:');
  migrate(db);
  const turnId = createTurn(db, 'organize', '2026-10-31T07:30:00Z');
  const call = (name: string, input: unknown) =>
    callTool(registry, name, input, {
      db,
      now: '2026-10-31T07:30:00Z',
      turnId,
      toolScope: 'vault',
      settings: {
        cutoffHour: 4,
        timeZone: 'America/Sao_Paulo',
        openSessionHours: 3,
        vaultDir,
        vaultMaxNotes: max,
      },
    });
  return { vaultDir, db, call };
};

describe('resolveNotePath', () => {
  it('aceita só pasta permitida e nome em minúsculas sem acento', () => {
    const d = path.join(os.tmpdir(), 'v');
    expect(resolveNotePath(d, 'metas/emagrecer-10kg.md')).toBe(
      path.join(d, 'impetus', 'metas', 'emagrecer-10kg.md'),
    );
    for (const bad of [
      '../x.md',
      'metas/../x.md',
      'metas/Meta.md',
      'metas/são.md',
      'diario/2026-10-30.md',
      'x.md',
      '/etc/passwd',
      'metas/a/b.md',
      'metas/a.txt',
    ])
      expect(resolveNotePath(d, bad)).toBeNull();
  });
});

describe('parseNote', () => {
  it('reconhece o dono pela linha origem: impetus', () => {
    expect(parseNote('---\norigem: impetus\ntitulo: "Meta"\n---\n# Meta\n')).toEqual({
      owner: 'impetus',
      title: 'Meta',
    });
    expect(parseNote('# nota do dono\n')).toEqual({ owner: 'dono' });
    expect(parseNote('---\r\ntags: [a]\r\n---\r\ntexto')).toEqual({ owner: 'dono' });
  });
});

describe('vault_upsert', () => {
  const input = {
    path: 'metas/emagrecer.md',
    title: 'Emagrecer 10 kg',
    entry: 'pesou 74,8 kg',
    day: '2026-10-30',
  };

  it('cria a nota com frontmatter, título e link para o diário', () => {
    const { vaultDir, call } = mk();
    const r = call('vault_upsert', input);
    expect(r).toMatchObject({ ok: true, data: { action: 'created' } });
    const md = fs.readFileSync(path.join(vaultDir, 'impetus', 'metas', 'emagrecer.md'), 'utf8');
    expect(md).toContain('origem: impetus');
    expect(md).toContain('titulo: "Emagrecer 10 kg"');
    expect(md).toContain('# Emagrecer 10 kg');
    expect(md).toContain('- 2026-10-30 — pesou 74,8 kg · [[diario/2026-10-30]]');
  });

  it('acrescenta em nota do bot, sem duplicar a mesma entrada', () => {
    const { vaultDir, call } = mk();
    call('vault_upsert', input);
    expect(call('vault_upsert', { ...input, entry: 'pesou 74,2 kg', day: '2026-10-31' })).toMatchObject({
      ok: true,
      data: { action: 'updated' },
    });
    expect(call('vault_upsert', { ...input, entry: 'pesou 74,2 kg', day: '2026-10-31' })).toMatchObject({
      ok: true,
      data: { action: 'unchanged' },
    });
    const md = fs.readFileSync(path.join(vaultDir, 'impetus', 'metas', 'emagrecer.md'), 'utf8');
    expect(md.match(/74,2 kg/g)).toHaveLength(1);
  });

  it('recusa nota do dono, caminho inválido e cofre desligado', () => {
    const { vaultDir, call } = mk();
    fs.mkdirSync(path.join(vaultDir, 'impetus', 'metas'), { recursive: true });
    fs.writeFileSync(path.join(vaultDir, 'impetus', 'metas', 'minha.md'), '# minha meta\n');
    expect(call('vault_upsert', { ...input, path: 'metas/minha.md' })).toMatchObject({
      ok: false,
      error: { code: 'FORBIDDEN' },
    });
    expect(call('vault_upsert', { ...input, path: '../fora.md' })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION' },
    });
    const off = callTool(registry, 'vault_upsert', input, {
      db: openDb(':memory:'),
      now: 'x',
      turnId: null,
      toolScope: 'vault',
      settings: { cutoffHour: 4, timeZone: 'America/Sao_Paulo', openSessionHours: 3 },
    });
    expect(off).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
  });

  it('o /desfazer ignora escritas do cofre', () => {
    const { db, call } = mk();
    expect(call('vault_upsert', input).ok).toBe(true);
    expect(lastTurnWithPendingWrites(db)).toBeUndefined();
  });

  it('respeita o limite de notas novas por dia (mesmo entre turnos) e registra no audit_log', () => {
    const { db, call } = mk(2);
    expect(call('vault_upsert', { ...input, path: 'metas/a.md' }).ok).toBe(true);
    expect(call('vault_upsert', { ...input, path: 'metas/b.md' }).ok).toBe(true);
    expect(call('vault_upsert', { ...input, path: 'metas/c.md' })).toMatchObject({
      ok: false,
      error: { code: 'CONFLICT' },
    });
    expect(db.prepare("SELECT count(*) FROM audit_log WHERE entity = 'vault_note'").pluck().get()).toBe(2);
  });

  it('redige segredos e achata quebras de linha da entrada', () => {
    const { vaultDir, call } = mk();
    call('vault_upsert', { ...input, entry: `chave ${'ab'.repeat(32)}\nsegunda linha` });
    const md = fs.readFileSync(path.join(vaultDir, 'impetus', 'metas', 'emagrecer.md'), 'utf8');
    expect(md).toContain('chave [redigido] segunda linha');
  });
});

describe('vault_list e vault_read', () => {
  it('lista com dono e título, e lê o conteúdo', () => {
    const { vaultDir, call } = mk();
    call('vault_upsert', { path: 'estudos/sql.md', title: 'SQL', entry: 'estudou joins', day: '2026-10-30' });
    fs.mkdirSync(path.join(vaultDir, 'impetus', 'ideias'), { recursive: true });
    fs.writeFileSync(path.join(vaultDir, 'impetus', 'ideias', 'minha-ideia.md'), '# ideia\n');
    const list = call('vault_list', {});
    expect(list).toMatchObject({ ok: true });
    expect((list as { data: { notes: unknown[] } }).data.notes).toEqual(
      expect.arrayContaining([
        { path: 'estudos/sql.md', title: 'SQL', owner: 'impetus' },
        { path: 'ideias/minha-ideia.md', title: 'minha-ideia', owner: 'dono' },
      ]),
    );
    expect(call('vault_read', { path: 'estudos/sql.md' })).toMatchObject({
      ok: true,
      data: { owner: 'impetus' },
    });
    expect(call('vault_read', { path: 'estudos/nao-existe.md' })).toMatchObject({
      ok: false,
      error: { code: 'NOT_FOUND' },
    });
  });
});
