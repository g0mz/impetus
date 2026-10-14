import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { splitMessage } from '../../src/channels/types.ts';
import { normalizeJid, parseWaMessage } from '../../src/channels/wa-parse.ts';
import { createDebouncer } from '../../src/gateway/debounce.ts';
import { MAX_SIDE, saveNormalizedImage } from '../../src/media/images.ts';

describe('parseWaMessage (formato Baileys)', () => {
  const base = {
    key: { id: 'A1', remoteJid: '5511999990000@s.whatsapp.net', remoteJidAlt: '123456789@lid' },
    messageTimestamp: 1760400000,
  };

  it('texto simples com JID e LID do remetente', () => {
    expect(parseWaMessage({ ...base, message: { conversation: ' oi ' } })).toEqual({
      id: 'A1',
      chatId: '5511999990000@s.whatsapp.net',
      senderIds: ['5511999990000@s.whatsapp.net', '123456789@lid'],
      text: 'oi',
      hasImage: false,
      hasAudio: false,
      quotedId: null,
      at: '2025-10-14T00:00:00Z',
    });
  });

  it('resposta citando mensagem do bot e imagem com legenda', () => {
    expect(
      parseWaMessage({
        ...base,
        message: { extendedTextMessage: { text: 'arroz foi 100g', contextInfo: { stanzaId: 'BOT9' } } },
      })?.quotedId,
    ).toBe('BOT9');
    const img = parseWaMessage({ ...base, message: { imageMessage: { caption: 'almoço' } } });
    expect(img).toMatchObject({ hasImage: true, text: 'almoço' });
    expect(
      parseWaMessage({ ...base, message: { ephemeralMessage: { message: { conversation: 'efêmera' } } } })
        ?.text,
    ).toBe('efêmera');
  });

  it('ignora mensagens próprias, grupos, status e sem conteúdo', () => {
    expect(
      parseWaMessage({ ...base, key: { ...base.key, fromMe: true }, message: { conversation: 'x' } }),
    ).toBeNull();
    expect(
      parseWaMessage({ key: { id: 'G', remoteJid: '1203@g.us' }, message: { conversation: 'x' } }),
    ).toBeNull();
    expect(
      parseWaMessage({ key: { id: 'S', remoteJid: 'status@broadcast' }, message: { conversation: 'x' } }),
    ).toBeNull();
    expect(parseWaMessage({ ...base, message: {} })).toBeNull();
  });

  it('normaliza JID com sufixo de dispositivo', () => {
    expect(normalizeJid('5511999990000:12@s.whatsapp.net')).toBe('5511999990000@s.whatsapp.net');
  });
});

describe('splitMessage', () => {
  it('não divide texto curto; divide em até 3 partes quebrando em linhas', () => {
    expect(splitMessage('curto')).toEqual(['curto']);
    const lines = Array.from({ length: 100 }, (_, i) => `linha ${i} ${'x'.repeat(40)}`).join('\n');
    const parts = splitMessage(lines, 1000, 3);
    expect(parts).toHaveLength(3);
    expect(parts.every((p) => p.length <= 1000)).toBe(true);
    expect(parts[0]!.endsWith('x')).toBe(true); // quebrou em fim de linha
    expect(parts[2]!.endsWith('…')).toBe(true); // excedente truncado
  });
});

describe('debounce (§4.2)', () => {
  type Item = { id: number; imageOnly: boolean };
  function fake() {
    let now = 0;
    const timers: { at: number; fn: () => void; h: number }[] = [];
    let seq = 0;
    return {
      setTimer: (fn: () => void, ms: number) => {
        const h = ++seq;
        timers.push({ at: now + ms, fn, h });
        return h;
      },
      clearTimer: (h: unknown) => {
        const i = timers.findIndex((t) => t.h === h);
        if (i >= 0) timers.splice(i, 1);
      },
      advance(ms: number) {
        now += ms;
        for (const t of [...timers].filter((x) => x.at <= now)) {
          timers.splice(timers.indexOf(t), 1);
          t.fn();
        }
      },
    };
  }

  it('foto seguida de texto em 10 s vira um turno só; texto sozinho fecha em 4 s', () => {
    const clock = fake();
    const flushed: Item[][] = [];
    const d = createDebouncer<Item>({ ms: 4000, imageMs: 20000, onFlush: (b) => flushed.push(b), ...clock });
    d.add({ id: 1, imageOnly: true });
    clock.advance(10_000);
    expect(flushed).toEqual([]);
    d.add({ id: 2, imageOnly: false });
    clock.advance(3999);
    expect(flushed).toEqual([]);
    clock.advance(1);
    expect(flushed.map((b) => b.map((x) => x.id))).toEqual([[1, 2]]);

    d.add({ id: 3, imageOnly: false });
    clock.advance(4000);
    expect(flushed.at(-1)!.map((x) => x.id)).toEqual([3]);
  });
});

describe('normalização de imagem', () => {
  it('limita a 1568 px, converte para JPEG e remove EXIF', async () => {
    const big = await sharp({ create: { width: 4000, height: 3000, channels: 3, background: '#c33' } })
      .withMetadata({ exif: { IFD0: { Artist: 'gps-e-dados-pessoais' } } })
      .jpeg()
      .toBuffer();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'impetus-img-'));
    const out = await saveNormalizedImage(big, dir, new Date('2026-10-13T12:00:00Z'));
    expect(out).toMatch(/2026[\\/]10[\\/][0-9a-f-]+\.jpg$/);
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe('jpeg');
    expect(Math.max(meta.width!, meta.height!)).toBe(MAX_SIDE);
    expect(meta.exif).toBeUndefined();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
