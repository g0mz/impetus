import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, REPO_ROOT, loadConfig } from '../../src/config.ts';

const BRAIN_DIR = path.join(os.tmpdir(), 'impetus-test-brain');

describe('loadConfig', () => {
  it('aplica os padrões do .env.example', () => {
    const c = loadConfig({ BRAIN_DIR });
    expect(c.DAY_CUTOFF_HOUR).toBe(4);
    expect(c.DEBOUNCE_IMAGE_MS).toBe(20_000);
    expect(c.REPORT_CHARTS).toBe(true);
    expect(c.REPORT_DAILY).toBe(false);
    expect(c.dbPath.endsWith(path.join('data', 'impetus.db'))).toBe(true);
  });

  it('converte tipos vindos do ambiente', () => {
    const c = loadConfig({
      BRAIN_DIR,
      DAY_CUTOFF_HOUR: '5',
      REPORT_DAILY: 'true',
      OPEN_SESSION_HOURS: '2.5',
    });
    expect(c.DAY_CUTOFF_HOUR).toBe(5);
    expect(c.REPORT_DAILY).toBe(true);
    expect(c.OPEN_SESSION_HOURS).toBe(2.5);
  });

  it('falha com mensagem clara e lista todos os problemas', () => {
    expect(() => loadConfig({ BRAIN_DIR, DAY_CUTOFF_HOUR: '25', CHANNEL: 'sms' })).toThrow(ConfigError);
    try {
      loadConfig({ BRAIN_DIR, DAY_CUTOFF_HOUR: '25', CHANNEL: 'sms' });
    } catch (e) {
      expect((e as Error).message).toMatch(/DAY_CUTOFF_HOUR/);
      expect((e as Error).message).toMatch(/CHANNEL/);
    }
  });

  it('exige a chave do provider escolhido', () => {
    expect(() => loadConfig({ BRAIN_DIR, BRAIN_PROVIDER: 'anthropic-api' })).toThrow(
      /IMPETUS_ANTHROPIC_API_KEY/,
    );
    expect(() => loadConfig({ BRAIN_DIR, BRAIN_PROVIDER: 'gemini' })).toThrow(/GEMINI_API_KEY/);
  });

  it('exige INGEST_API_KEY forte em produção', () => {
    expect(() => loadConfig({ BRAIN_DIR, NODE_ENV: 'production' })).toThrow(/INGEST_API_KEY/);
    expect(() => loadConfig({ BRAIN_DIR, NODE_ENV: 'production', INGEST_API_KEY: 'curta' })).toThrow(
      /32\+ bytes/,
    );
    expect(loadConfig({ BRAIN_DIR, NODE_ENV: 'production', INGEST_API_KEY: 'a'.repeat(64) }).NODE_ENV).toBe(
      'production',
    );
  });

  it('não ecoa o valor de segredos na mensagem de erro', () => {
    const secret = 'segredo-que-nao-pode-vazar';
    expect(() => loadConfig({ BRAIN_DIR, NODE_ENV: 'production', INGEST_API_KEY: secret })).toThrow(
      expect.not.objectContaining({ message: expect.stringContaining(secret) }),
    );
  });

  it('recusa BRAIN_DIR dentro do repositório (o coach herdaria o CLAUDE.md)', () => {
    expect(() => loadConfig({ BRAIN_DIR: path.join(REPO_ROOT, 'data', 'brain') })).toThrow(/BRAIN_DIR/);
    expect(() => loadConfig({ BRAIN_DIR: REPO_ROOT })).toThrow(/BRAIN_DIR/);
  });
});
