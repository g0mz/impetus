import { describe, expect, it } from 'vitest';
import type { Channel, InboundMessage } from '../../src/channels/types.ts';
import { createInbox } from '../../src/gateway/inbox.ts';
import type { RunTurn, TurnRequest } from '../../src/gateway/turn-runner.ts';
import { t } from '../../src/i18n/pt-br.ts';
import { createLogger } from '../../src/logger.ts';
import { cleanTranscript, type Transcriber } from '../../src/media/transcribe.ts';
import { buildRegistry } from '../../src/tools/index.ts';
import { SETTINGS, makeDb } from '../helpers.ts';

function setup(transcribe?: Transcriber) {
  const { db } = makeDb();
  const sent: string[] = [];
  const turns: TurnRequest[] = [];
  const channel: Channel = {
    name: 'terminal',
    start: async () => {},
    send: async (text) => {
      sent.push(text);
      return { externalIds: [`out-${sent.length}`] };
    },
    stop: async () => {},
  };
  const runTurn = (async (req: TurnRequest) => {
    turns.push(req);
    return { turnId: 1, status: 'done', text: 'registrado', entities: [] };
  }) as unknown as RunTurn;
  const handle = createInbox({
    db,
    channel,
    registry: buildRegistry(),
    settings: SETTINGS,
    runTurn,
    logger: createLogger('silent'),
    clock: () => '2026-10-14T21:00:00Z',
    audioMaxSeconds: 60,
    ...(transcribe ? { transcribe } : {}),
  });
  let n = 0;
  const voice = async (extra: Partial<InboundMessage> = {}) => {
    await handle({
      externalId: `v${++n}`,
      text: null,
      imagePath: null,
      audioPath: '/tmp/voz.ogg',
      audioSeconds: 8,
      quotedExternalId: null,
      at: '2026-10-14T21:00:00Z',
      ...extra,
    });
    await handle.drain();
  };
  return { db, sent, turns, voice };
}

describe('mensagens de voz', () => {
  it('transcreve e manda ao cérebro com o marcador 🎤; grava o texto na mensagem', async () => {
    const g = setup(async () => ({ ok: true, text: 'supino três por dez com trinta quilos', ms: 900 }));
    await g.voice();
    expect(g.turns).toHaveLength(1);
    expect(g.turns[0]!.userText).toBe('🎤 supino três por dez com trinta quilos');
    expect(g.turns[0]!.images).toEqual([]);
    expect(g.sent).toEqual(['registrado']);
    expect(g.db.prepare("SELECT kind, text FROM messages WHERE direction = 'in'").get()).toEqual({
      kind: 'audio',
      text: 'supino três por dez com trinta quilos',
    });
  });

  it('comando falado não vira comando', async () => {
    const g = setup(async () => ({ ok: true, text: '/desfazer', ms: 1 }));
    await g.voice();
    expect(g.turns[0]!.userText).toBe('🎤 /desfazer');
  });

  it('sem transcrição configurada, áudio longo e falha: responde sem chamar o cérebro', async () => {
    const off = setup();
    await off.voice();
    expect(off.sent).toEqual([t.audioUnavailable]);

    const long = setup(async () => ({ ok: true, text: 'x', ms: 1 }));
    await long.voice({ audioSeconds: 90 });
    expect(long.sent).toEqual([t.audioTooLong(60)]);

    const bad = setup(async () => ({ ok: false, error: 'boom' }));
    await bad.voice();
    expect(bad.sent).toEqual([t.audioFailed]);
    for (const g of [off, long, bad]) expect(g.turns).toEqual([]);
  });

  it('transcreve um áudio por vez', async () => {
    let running = 0;
    let peak = 0;
    const g = setup(async () => {
      peak = Math.max(peak, ++running);
      await new Promise((r) => setTimeout(r, 20));
      running--;
      return { ok: true, text: 'ok', ms: 20 };
    });
    await Promise.all([g.voice(), g.voice(), g.voice()]);
    expect(peak).toBe(1);
  });
});

describe('cleanTranscript', () => {
  it('remove marcações do Whisper', () => {
    expect(cleanTranscript(' [BLANK_AUDIO]\n  comi arroz (música) e feijão  ')).toBe('comi arroz e feijão');
    expect(cleanTranscript('[BLANK_AUDIO]')).toBe('');
  });
});
