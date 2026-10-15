import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { inspectAuthDir, setAsideAuthDir } from '../../src/channels/wa-auth.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wa-auth-'));

describe('sessão do WhatsApp em disco', () => {
  it('detecta sem sessão, vinculada e incompleta (creds vazio ou sem registro)', () => {
    const dir = path.join(tmp(), 'wa-auth');
    expect(inspectAuthDir(dir)).toBe('none');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'creds.json'), '');
    expect(inspectAuthDir(dir)).toBe('incomplete');
    fs.writeFileSync(path.join(dir, 'creds.json'), JSON.stringify({ registered: false, me: { id: 'x' } }));
    expect(inspectAuthDir(dir)).toBe('incomplete');
    fs.writeFileSync(path.join(dir, 'creds.json'), JSON.stringify({ registered: true, me: { id: 'x' } }));
    expect(inspectAuthDir(dir)).toBe('registered');
  });

  it('move a sessão para .bak sem apagar', () => {
    const dir = path.join(tmp(), 'wa-auth');
    fs.mkdirSync(dir);
    const dest = setAsideAuthDir(dir, new Date('2026-10-14T20:00:00Z'));
    expect(dest).toBe(`${dir}.bak-2026-10-14T20-00-00-000Z`);
    expect(fs.existsSync(dir)).toBe(false);
    expect(fs.existsSync(dest)).toBe(true);
  });
});

describe('waitChannelOpen', () => {
  it('pronto sem status; espera até abrir; desiste no timeout', async () => {
    const { waitChannelOpen } = await import('../../src/app.ts');
    const ch = (s: () => string) => ({ status: s }) as unknown as Parameters<typeof waitChannelOpen>[0];
    expect(await waitChannelOpen({} as Parameters<typeof waitChannelOpen>[0], 10, 1)).toBe(true);
    let n = 0;
    expect(
      await waitChannelOpen(
        ch(() => (++n > 2 ? 'open desde x' : 'connecting')),
        100,
        1,
      ),
    ).toBe(true);
    expect(
      await waitChannelOpen(
        ch(() => 'closed'),
        5,
        1,
      ),
    ).toBe(false);
  });
});
