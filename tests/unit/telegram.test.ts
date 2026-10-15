import { describe, expect, it } from 'vitest';
import { createTelegramChannel } from '../../src/channels/telegram.ts';
import { parseTgUpdate } from '../../src/channels/tg-parse.ts';
import { createLogger } from '../../src/logger.ts';

const msg = (extra: Record<string, unknown> = {}) => ({
  update_id: 10,
  message: {
    message_id: 5,
    date: 1760400000,
    chat: { id: 42, type: 'private' },
    from: { id: 42 },
    ...extra,
  },
});

describe('parseTgUpdate', () => {
  it('texto com id único por chat e remetente prefixado', () => {
    expect(parseTgUpdate(msg({ text: ' oi ' }))).toEqual({
      id: '42:5',
      chatId: '42',
      senderIds: ['tg:42'],
      text: 'oi',
      imageFileId: null,
      hasAudio: false,
      quotedId: null,
      at: '2025-10-14T00:00:00Z',
    });
  });

  it('foto escolhe a maior resolução; legenda vira texto; citação vira id externo', () => {
    const p = parseTgUpdate(
      msg({
        caption: 'almoço',
        photo: [
          { file_id: 'small', width: 90, height: 90 },
          { file_id: 'big', width: 1280, height: 960 },
        ],
        reply_to_message: { message_id: 3 },
      }),
    );
    expect(p).toMatchObject({ imageFileId: 'big', text: 'almoço', quotedId: '42:3' });
    expect(parseTgUpdate(msg({ document: { file_id: 'doc', mime_type: 'image/png' } }))?.imageFileId).toBe(
      'doc',
    );
  });

  it('ignora grupos, bots, mensagens vazias e updates sem message', () => {
    expect(parseTgUpdate(msg({ text: 'x', chat: { id: -1, type: 'group' } }))).toBeNull();
    expect(parseTgUpdate(msg({ text: 'x', from: { id: 1, is_bot: true } }))).toBeNull();
    expect(parseTgUpdate(msg({ sticker: {} }))).toBeNull();
    expect(parseTgUpdate({ update_id: 1 })).toBeNull();
    expect(parseTgUpdate(msg({ voice: {} }))?.hasAudio).toBe(true);
  });
});

describe('createTelegramChannel', () => {
  const TOKEN = '123:SECRET';

  function fakeApi(updates: unknown[]) {
    const calls: { method: string; body: unknown }[] = [];
    let served = false;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const method = String(url).split('/').pop()!;
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body;
      calls.push({ method, body });
      let result: unknown = true;
      if (method === 'getUpdates') {
        if (served) {
          await new Promise((_, rej) =>
            init?.signal?.addEventListener('abort', () =>
              rej(Object.assign(new Error('x'), { name: 'AbortError' })),
            ),
          );
        }
        served = true;
        result = updates;
      }
      if (method === 'sendMessage') result = { message_id: 100 + calls.length };
      return new Response(JSON.stringify({ ok: true, result }));
    }) as typeof fetch;
    return { calls, fetchImpl };
  }

  it('recebe, confirma o offset e responde dividindo em partes', async () => {
    const { calls, fetchImpl } = fakeApi([msg({ text: 'oi' })]);
    const ch = createTelegramChannel({
      token: TOKEN,
      mediaDir: '/tmp',
      logger: createLogger('silent'),
      defaultTo: () => undefined,
      fetchImpl,
    });
    const got: string[] = [];
    let resolveGot: () => void;
    const received = new Promise<void>((r) => (resolveGot = r));
    const running = ch.start(async (m) => {
      got.push(m.externalId);
      resolveGot();
    });
    await received;
    await ch.processing!(
      { externalId: '42:5', chatId: '42', text: 'oi', imagePath: null, quotedExternalId: null, at: '' },
      true,
    );
    const sent = await ch.send('a'.repeat(5000));
    await ch.stop();
    await running;

    expect(got).toEqual(['42:5']);
    expect(sent.externalIds).toHaveLength(2);
    expect(sent.externalIds[0]).toMatch(/^42:\d+$/);
    const polls = calls
      .filter((c) => c.method === 'getUpdates')
      .map((c) => (c.body as { offset: number }).offset);
    expect(polls).toEqual([0, 11]);
    expect(calls.map((c) => c.method)).toContain('setMessageReaction');
    expect(ch.status!()).toBe('closed');
  });

  it('erros da API não vazam o token', async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized' }),
      )) as unknown as typeof fetch;
    const ch = createTelegramChannel({
      token: TOKEN,
      mediaDir: '/tmp',
      logger: createLogger('silent'),
      defaultTo: () => '42',
      fetchImpl,
    });
    const err = await ch.send('oi').catch((e: Error) => e);
    expect(String(err)).toContain('401');
    expect(String(err)).not.toContain('SECRET');
  });
});
