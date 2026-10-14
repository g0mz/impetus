import { describe, expect, it } from 'vitest';
import type { Channel, InboundMessage } from '../../src/channels/types.ts';
import { getSetting } from '../../src/db/repos/settings.ts';
import { createInbox } from '../../src/gateway/inbox.ts';
import { createOwnerGuard } from '../../src/gateway/owner-pairing.ts';
import type { RunTurn } from '../../src/gateway/turn-runner.ts';
import { createLogger, type Logger } from '../../src/logger.ts';
import { buildRegistry } from '../../src/tools/index.ts';
import { SETTINGS, makeDb } from '../helpers.ts';

/** Logger que captura o código de pareamento mostrado no log. */
function captureLogger() {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger('debug', {
    write: (s: string) => void lines.push(JSON.parse(s) as Record<string, unknown>),
  });
  return {
    logger: logger as Logger,
    code: () => lines.findLast((l) => typeof l.code === 'string')?.code as string,
  };
}

function setup(opts: { debounceMs?: number } = {}) {
  const { db } = makeDb();
  const { logger, code } = captureLogger();
  const owner = createOwnerGuard(db, logger);
  const sent: { text: string; to?: string }[] = [];
  const turns: { userText: string; images: string[] }[] = [];
  let n = 0;
  const channel: Channel = {
    name: 'whatsapp',
    start: async () => {},
    send: async (text, o) => {
      sent.push({ text, ...(o?.to ? { to: o.to } : {}) });
      return { externalIds: [`out-${++n}`] };
    },
    status: () => 'open',
    stop: async () => {},
  };
  const runTurn: RunTurn = async (req) => {
    turns.push({ userText: req.userText, images: req.images });
    return { turnId: 1, status: 'done', text: `ok: ${req.userText}`, entities: [] };
  };
  const handle = createInbox({
    db,
    channel,
    registry: buildRegistry(),
    settings: SETTINGS,
    runTurn,
    logger,
    owner,
    ...(opts.debounceMs ? { debounceMs: opts.debounceMs, debounceImageMs: opts.debounceMs * 5 } : {}),
  });
  let seq = 0;
  const msg = (
    senderIds: string[],
    text: string | null,
    extra: Partial<InboundMessage> = {},
  ): InboundMessage => ({
    externalId: `w-${++seq}`,
    senderIds,
    chatId: senderIds[0]!,
    text,
    imagePath: null,
    quotedExternalId: null,
    at: '2026-10-13T21:00:00Z',
    ...extra,
  });
  return { db, owner, code, sent, turns, handle, msg };
}

const ME = ['5511988887777@s.whatsapp.net', '99887766@lid'];
const STRANGER = ['5521911112222@s.whatsapp.net'];

describe('pareamento do dono e allowlist', () => {
  it('sem dono: só "PAREAR <código>" correto pareia (JID + LID); estranhos são ignorados em silêncio', async () => {
    const g = setup();
    expect(g.owner.hasOwner()).toBe(false);
    await g.handle(g.msg(STRANGER, 'oi'));
    await g.handle(g.msg(ME, 'PAREAR 000000' === `PAREAR ${g.code()}` ? 'PAREAR 111111' : 'PAREAR 000000'));
    expect(g.sent).toEqual([]);
    expect(g.db.prepare('SELECT count(*) FROM messages').pluck().get()).toBe(0);

    await g.handle(g.msg(ME, `PAREAR ${g.code()}`));
    expect(g.sent.at(-1)!.text).toMatch(/Pareado/);
    expect(getSetting(g.db, 'owner.ids')).toEqual(ME);
    expect(getSetting(g.db, 'owner.chat_jid')).toBe(ME[0]);

    await g.handle(g.msg(STRANGER, `PAREAR ${g.code() ?? '123456'}`));
    await g.handle(g.msg(STRANGER, '/ajuda'));
    expect(g.sent).toHaveLength(1); // estranho continua ignorado, mesmo após o pareamento

    await g.handle(g.msg([ME[1]!], '/status')); // dono escrevendo só pelo LID
    expect(g.sent.at(-1)).toMatchObject({ to: ME[1] });
    expect(g.sent.at(-1)!.text).toContain('• Canal: open');
  });

  it('aprende identificadores novos do dono (migração para LID)', async () => {
    const g = setup();
    await g.handle(g.msg([ME[0]!], `PAREAR ${g.code()}`));
    await g.handle(g.msg([ME[0]!, '777@lid'], '/ajuda'));
    expect(getSetting(g.db, 'owner.ids')).toEqual([ME[0], '777@lid']);
  });

  it('5 códigos errados geram um código novo', async () => {
    const g = setup();
    const first = g.code();
    const wrong = first === '000000' ? '000001' : '000000';
    for (let i = 0; i < 5; i++) await g.handle(g.msg(ME, `PAREAR ${wrong}`));
    expect(g.code()).not.toBe(first);
    await g.handle(g.msg(ME, `PAREAR ${first}`));
    expect(g.owner.hasOwner()).toBe(false);
  });
});

describe('debounce e fila no inbox', () => {
  it('foto sem legenda + texto viram um turno; comandos respondem na hora', async () => {
    const g = setup({ debounceMs: 30 });
    await g.handle(g.msg(ME, `PAREAR ${g.code()}`));
    await g.handle(g.msg(ME, null, { imagePath: '/media/a.jpg' }));
    await g.handle(g.msg(ME, '/metas'));
    expect(g.sent.at(-1)!.text).toMatch(/Nenhuma meta/);
    await g.handle(g.msg(ME, 'almoço, frango 150g'));
    await new Promise((r) => setTimeout(r, 120));
    await g.handle.drain();
    expect(g.turns).toEqual([{ userText: 'almoço, frango 150g', images: ['/media/a.jpg'] }]);
    expect(g.sent.at(-1)!.text).toBe('ok: almoço, frango 150g');
  });
});
