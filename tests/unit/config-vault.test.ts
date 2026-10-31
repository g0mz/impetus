import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, REPO_ROOT, loadConfig } from '../../src/config.ts';

const abs = (...p: string[]) => path.join(os.tmpdir(), 'impetus-vault-test', ...p);

describe('VAULT_DIR', () => {
  it('é opcional e os padrões valem sem ele', () => {
    const c = loadConfig({});
    expect(c.VAULT_DIR).toBeUndefined();
    expect(c.VAULT_ORGANIZE_MAX_NOTES).toBe(10);
    expect(c.VAULT_ORGANIZE_CRON).toBe('30 4 * * *');
  });

  it('aceita caminho absoluto fora do repositório e do DATA_DIR', () => {
    const c = loadConfig({ VAULT_DIR: abs('vault'), DATA_DIR: abs('data') });
    expect(c.VAULT_DIR).toBe(path.resolve(abs('vault')));
  });

  it('recusa caminho relativo', () => {
    expect(() => loadConfig({ VAULT_DIR: 'vault' })).toThrow(ConfigError);
  });

  it('recusa caminho dentro do repositório', () => {
    expect(() => loadConfig({ VAULT_DIR: path.join(REPO_ROOT, 'vault') })).toThrow(/VAULT_DIR/);
  });

  it('recusa caminho dentro do DATA_DIR (e DATA_DIR dentro do cofre)', () => {
    expect(() => loadConfig({ VAULT_DIR: abs('data', 'vault'), DATA_DIR: abs('data') })).toThrow(/VAULT_DIR/);
    expect(() => loadConfig({ VAULT_DIR: abs('vault'), DATA_DIR: abs('vault', 'data') })).toThrow(
      /VAULT_DIR/,
    );
  });
});
