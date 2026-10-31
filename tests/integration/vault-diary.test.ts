import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/index.ts';
import { migrate } from '../../src/db/migrate.ts';
import { insertMessage, setMessagesTurn } from '../../src/db/repos/messages.ts';
import { createTurn, finishTurn } from '../../src/db/repos/turns.ts';
import { diaryEntries, messageDays, renderDiary, syncDiary, writeDiary } from '../../src/vault/diary.ts';

const O = { cutoffHour: 4, timeZone: 'America/Sao_Paulo' };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vault-diary-'));

function db0(): Db {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

let n = 0;
function say(
  db: Db,
  direction: 'in' | 'out',
  text: string | null,
  at: string,
  extra: Record<string, unknown> = {},
) {
  return insertMessage(db, {
    channel: 'telegram',
    direction,
    external_id: `m${++n}`,
    kind: 'text',
    text,
    created_at: at,
    ...extra,
  }).id;
}

/** Turno `done` com uma pergunta e uma resposta. */
function turn(db: Db, q: string, a: string, qAt: string, aAt: string, status: 'done' | 'failed' = 'done') {
  const turnId = createTurn(db, 'chat', qAt);
  const inId = say(db, 'in', q, qAt);
  setMessagesTurn(db, [inId], turnId, 'processed');
  say(db, 'out', a, aAt, { turn_id: turnId });
  finishTurn(db, turnId, { status }, aAt);
  return turnId;
}

describe('diaryEntries', () => {
  it('uma linha por mensagem, com horário local e autor', () => {
    const db = db0();
    turn(db, 'acordei 7h', 'Bom dia!', '2026-10-30T10:41:00Z', '2026-10-30T10:41:20Z');
    expect(diaryEntries(db, '2026-10-30', O)).toEqual([
      '- 07:41 **eu:** acordei 7h',
      '- 07:41 **bot:** Bom dia!',
    ]);
  });

  it('deixa de fora comandos, pareamento, saídas sem turno e respostas de turno que falhou', () => {
    const db = db0();
    say(db, 'in', '/ajuda', '2026-10-30T10:00:00Z');
    say(db, 'in', 'PAREAR 123456', '2026-10-30T10:01:00Z');
    say(db, 'out', 'relatório da semana', '2026-10-30T10:02:00Z'); // turn_id nulo
    turn(db, 'oi', 'deu erro, tente de novo', '2026-10-30T10:03:00Z', '2026-10-30T10:03:05Z', 'failed');
    const cmd = createTurn(db, 'command', '2026-10-30T10:04:00Z'); // resposta de comando (ex.: /desfazer)
    say(db, 'out', 'Desfeito: 1 refeição', '2026-10-30T10:04:01Z', { turn_id: cmd });
    finishTurn(db, cmd, { status: 'done' }, '2026-10-30T10:04:01Z');
    expect(diaryEntries(db, '2026-10-30', O)).toEqual(['- 07:03 **eu:** oi']);
  });

  it('a resposta fica no dia da pergunta quando o turno cruza a virada das 04:00', () => {
    const db = db0();
    turn(db, 'boa noite', 'Descansa!', '2026-10-30T06:59:00Z', '2026-10-30T07:01:00Z'); // 03:59 e 04:01 locais
    expect(diaryEntries(db, '2026-10-29', O)).toEqual([
      '- 03:59 **eu:** boa noite',
      '- 04:01 **bot:** Descansa!',
    ]);
    expect(diaryEntries(db, '2026-10-30', O)).toEqual([]);
  });

  it('marca foto e áudio e mantém legenda/transcrição', () => {
    const db = db0();
    say(db, 'in', 'prato do almoço', '2026-10-30T15:00:00Z', { kind: 'image' });
    say(db, 'in', 'comi arroz e frango', '2026-10-30T15:01:00Z', { kind: 'audio' });
    say(db, 'in', null, '2026-10-30T15:02:00Z', { kind: 'image' });
    expect(diaryEntries(db, '2026-10-30', O)).toEqual([
      '- 12:00 **eu:** [foto] prato do almoço',
      '- 12:01 **eu:** [áudio] comi arroz e frango',
      '- 12:02 **eu:** [foto]',
    ]);
  });

  it('escapa markdown do usuário, indenta continuações e redige segredos', () => {
    const db = db0();
    say(db, 'in', `#treino de [[peito]]\n---\ntoken ${'ab'.repeat(32)}`, '2026-10-30T10:00:00Z');
    expect(diaryEntries(db, '2026-10-30', O)).toEqual([
      '- 07:00 **eu:** \\#treino de \\[\\[peito\\]\\]\n  ---\n  token [redigido]',
    ]);
  });
});

describe('renderDiary', () => {
  it('frontmatter gerado e nunca começa com texto do usuário', () => {
    const md = renderDiary('2026-10-30', ['- 07:41 **eu:** oi']);
    expect(md.startsWith('---\ngerado: true\ndata: 2026-10-30\ntags: [diario]\n---\n')).toBe(true);
    expect(md).toContain('- 07:41 **eu:** oi');
    expect(md.endsWith('\n')).toBe(true);
  });
});

describe('writeDiary / syncDiary / messageDays', () => {
  it('não cria arquivo de dia sem mensagens', () => {
    const db = db0();
    const dir = tmp();
    expect(writeDiary(db, dir, '2026-10-30', O)).toBe(false);
    expect(fs.existsSync(path.join(dir, 'impetus', 'diario', '2026-10-30.md'))).toBe(false);
  });

  it('syncDiary grava hoje e ontem só quando chega mensagem nova, e não reescreve o que não mudou', () => {
    const db = db0();
    const dir = tmp();
    turn(db, 'oi', 'olá', '2026-10-30T15:00:00Z', '2026-10-30T15:00:05Z');
    const now = '2026-10-30T20:00:00Z';
    expect(syncDiary(db, dir, now, O)).toBe('1 arquivo(s)');
    const file = path.join(dir, 'impetus', 'diario', '2026-10-30.md');
    expect(fs.readFileSync(file, 'utf8')).toContain('**eu:** oi');
    expect(syncDiary(db, dir, now, O)).toBe('sem mensagens novas');

    const old = new Date('2020-01-01T00:00:00Z');
    fs.utimesSync(file, old, old);
    say(db, 'in', 'mais uma', '2026-10-30T16:00:00Z');
    expect(syncDiary(db, dir, now, O)).toBe('1 arquivo(s)');
    expect(fs.readFileSync(file, 'utf8')).toContain('mais uma');
  });

  it('messageDays lista todos os dias entre a primeira e a última mensagem', () => {
    const db = db0();
    say(db, 'in', 'a', '2026-10-28T15:00:00Z');
    say(db, 'in', 'b', '2026-10-30T15:00:00Z');
    expect(messageDays(db, O)).toEqual(['2026-10-28', '2026-10-29', '2026-10-30']);
    expect(messageDays(db0(), O)).toEqual([]);
  });

  it('resposta longa dividida em partes (mesmo turno e mesmo texto) aparece uma vez', () => {
    const db = db0();
    const turnId = createTurn(db, 'chat', '2026-10-30T10:41:00Z');
    setMessagesTurn(db, [say(db, 'in', 'me conta tudo', '2026-10-30T10:41:00Z')], turnId, 'processed');
    say(db, 'out', 'resposta longa', '2026-10-30T10:41:20Z', { turn_id: turnId });
    say(db, 'out', 'resposta longa', '2026-10-30T10:41:21Z', { turn_id: turnId });
    finishTurn(db, turnId, { status: 'done' }, '2026-10-30T10:41:21Z');
    const lines = diaryEntries(db, '2026-10-30', O).filter((l) => l.includes('**bot:**'));
    expect(lines).toEqual(['- 07:41 **bot:** resposta longa']);
  });

  it('saídas do mesmo turno com textos diferentes são mantidas', () => {
    const db = db0();
    const turnId = createTurn(db, 'chat', '2026-10-30T10:41:00Z');
    setMessagesTurn(db, [say(db, 'in', 'oi', '2026-10-30T10:41:00Z')], turnId, 'processed');
    say(db, 'out', 'primeira parte', '2026-10-30T10:41:20Z', { turn_id: turnId });
    say(db, 'out', 'segunda parte', '2026-10-30T10:41:21Z', { turn_id: turnId });
    finishTurn(db, turnId, { status: 'done' }, '2026-10-30T10:41:21Z');
    expect(diaryEntries(db, '2026-10-30', O).filter((l) => l.includes('**bot:**'))).toEqual([
      '- 07:41 **bot:** primeira parte',
      '- 07:41 **bot:** segunda parte',
    ]);
  });

  it('reação ao fim da linha anterior, sem linha própria', () => {
    const db = db0();
    const turnId = createTurn(db, 'chat', '2026-10-30T10:41:00Z');
    setMessagesTurn(db, [say(db, 'in', 'valeu', '2026-10-30T10:41:00Z')], turnId, 'processed');
    say(db, 'out', '👍', '2026-10-30T10:41:05Z', { turn_id: turnId, kind: 'reaction' });
    finishTurn(db, turnId, { status: 'done' }, '2026-10-30T10:41:05Z');
    expect(diaryEntries(db, '2026-10-30', O)).toEqual(['- 07:41 **eu:** valeu 👍']);
  });

  it('reação sem entrada anterior no dia é descartada', () => {
    const db = db0();
    const turnId = createTurn(db, 'chat', '2026-10-30T10:41:00Z');
    say(db, 'out', '👍', '2026-10-30T10:41:05Z', { turn_id: turnId, kind: 'reaction' });
    finishTurn(db, turnId, { status: 'done' }, '2026-10-30T10:41:05Z');
    expect(diaryEntries(db, '2026-10-30', O)).toEqual([]);
  });
});
