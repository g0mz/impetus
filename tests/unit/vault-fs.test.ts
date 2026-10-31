import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeIfChanged } from '../../src/vault/fs.ts';
import { redactSecrets } from '../../src/vault/redact.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vault-fs-'));

describe('redactSecrets', () => {
  it('tira token de bot do Telegram, chave sk- e hex de 64', () => {
    const s = redactSecrets(
      `bot 1234567890:${'A'.repeat(35)} chave sk-ant-${'x'.repeat(30)} hex ${'ab'.repeat(32)} ok`,
    );
    expect(s).toBe('bot [redigido] chave [redigido] hex [redigido] ok');
  });

  it('não mexe em texto comum (peso, horários, datas)', () => {
    expect(redactSecrets('pesei 74,8 às 07:41 em 2026-10-30')).toBe('pesei 74,8 às 07:41 em 2026-10-30');
  });
});

describe('writeIfChanged', () => {
  it('cria diretórios, grava e devolve true; sem mudança devolve false e não toca o mtime', () => {
    const file = path.join(tmp(), 'a', 'b.md');
    expect(writeIfChanged(file, 'x\n')).toBe(true);
    const old = new Date('2020-01-01T00:00:00Z');
    fs.utimesSync(file, old, old);
    expect(writeIfChanged(file, 'x\n')).toBe(false);
    expect(fs.statSync(file).mtime.getTime()).toBe(old.getTime());
    expect(writeIfChanged(file, 'y\n')).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe('y\n');
  });

  it('não deixa arquivo temporário para trás', () => {
    const dir = tmp();
    writeIfChanged(path.join(dir, 'n.md'), 'z');
    expect(fs.readdirSync(dir)).toEqual(['n.md']);
  });
});
