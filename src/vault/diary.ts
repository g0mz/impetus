import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/index.ts';
import { getSetting, setSetting } from '../db/repos/settings.ts';
import { addDays, localDayBounds, toLocalDate, toUtcIso, wallClock } from '../time.ts';
import { writeIfChanged } from './fs.ts';
import { redactSecrets } from './redact.ts';

export type DiaryOpts = { cutoffHour: number; timeZone: string };

type Row = {
  direction: 'in' | 'out';
  kind: string;
  text: string | null;
  status: string;
  turn_id: number | null;
  created_at: string;
  turn_status: string | null;
  turn_kind: string | null;
  /** Primeira mensagem de entrada do mesmo turno: a resposta pertence ao dia dela. */
  anchor_at: string | null;
};

const PAIRING = /^PAREAR\s+\d{6}$/i;
const pad = (n: number) => String(n).padStart(2, '0');

function rowsAround(db: Db, day: string, o: DiaryOpts): Row[] {
  const { start, end } = localDayBounds(day, o.cutoffHour, o.timeZone);
  // resposta de turno adiado (retry horário) pode chegar horas depois do fim do dia
  const until = toUtcIso(new Date(Date.parse(end) + 24 * 3600_000));
  return db
    .prepare(
      `SELECT m.direction, m.kind, m.text, m.status, m.turn_id, m.created_at, t.status AS turn_status, t.kind AS turn_kind,
              (SELECT min(i.created_at) FROM messages i WHERE i.turn_id = m.turn_id AND i.direction = 'in') AS anchor_at
         FROM messages m LEFT JOIN turns t ON t.id = m.turn_id
        WHERE m.created_at >= ? AND m.created_at < ?
        ORDER BY m.id`,
    )
    .all(start, until) as Row[];
}

/**
 * Fora do diário: comandos e suas respostas (turno `command`), pareamento, saídas sem turno (relatórios
 * agendados) e respostas de turno falho/adiado. Check-ins entram: são mensagens do coach.
 */
function keep(r: Row): boolean {
  if (r.status === 'ignored') return false;
  if (r.direction === 'in') {
    const text = r.text?.trim() ?? '';
    return !text.startsWith('/') && !PAIRING.test(text);
  }
  return (
    r.turn_id !== null &&
    r.turn_kind !== 'command' &&
    r.turn_status !== 'failed' &&
    r.turn_status !== 'deferred'
  );
}

const escapeMd = (s: string) =>
  s
    .replace(/\[\[/g, '\\[\\[')
    .replace(/\]\]/g, '\\]\\]')
    .replace(/#(?=[\p{L}\p{N}_/-])/gu, '\\#');

function body(r: Row): string {
  const text = escapeMd(redactSecrets(r.text?.trim() ?? ''));
  if (r.kind === 'image') return text ? `[foto] ${text}` : '[foto]';
  if (r.kind === 'audio') return text ? `[áudio] ${text}` : '[áudio]';
  return text;
}

function entry(r: Row, timeZone: string): string {
  const w = wallClock(r.created_at, timeZone);
  const [first = '', ...rest] = body(r).split('\n');
  const head = `- ${pad(w.hour)}:${pad(w.minute)} **${r.direction === 'in' ? 'eu' : 'bot'}:** ${first}`;
  return [head, ...rest.map((l) => `  ${l}`.trimEnd())].join('\n');
}

/** Uma entrada por mensagem do dia contábil `day` (a resposta segue o dia da pergunta). */
export function diaryEntries(db: Db, day: string, o: DiaryOpts): string[] {
  return rowsAround(db, day, o)
    .filter((r) => keep(r) && toLocalDate(r.anchor_at ?? r.created_at, o.cutoffHour, o.timeZone) === day)
    .filter((r) => body(r) !== '')
    .map((r) => entry(r, o.timeZone));
}

export function renderDiary(day: string, entries: string[]): string {
  const head = ['---', 'gerado: true', `data: ${day}`, 'tags: [diario]', '---', `# Diário ${day}`, ''];
  return [...head, ...(entries.length ? entries : ['_sem mensagens_']), ''].join('\n');
}

/** Grava `impetus/diario/AAAA-MM-DD.md`; dia sem mensagens e sem arquivo não cria nada. */
export function writeDiary(db: Db, vaultDir: string, day: string, o: DiaryOpts): boolean {
  const file = path.join(vaultDir, 'impetus', 'diario', `${day}.md`);
  const entries = diaryEntries(db, day, o);
  if (!entries.length && !fs.existsSync(file)) return false;
  return writeIfChanged(file, renderDiary(day, entries));
}

/**
 * Job `vault.diary`: refaz ontem e hoje, mas só se chegou mensagem nova desde a última execução.
 * Turno adiado respondido depois de mais de um dia não reabre o diário antigo (rode `vault:backfill`).
 */
export function syncDiary(db: Db, vaultDir: string, now: string, o: DiaryOpts): string {
  const last = getSetting<number>(db, 'vault.diary.last_id') ?? 0;
  const max = db.prepare('SELECT coalesce(max(id), 0) FROM messages').pluck().get() as number;
  if (max === last) return 'sem mensagens novas';
  const today = toLocalDate(now, o.cutoffHour, o.timeZone);
  let changed = 0;
  for (const day of [addDays(today, -1), today]) if (writeDiary(db, vaultDir, day, o)) changed++;
  setSetting(db, 'vault.diary.last_id', max);
  return `${changed} arquivo(s)`;
}

/** Todos os dias contábeis entre a primeira e a última mensagem (backfill). */
export function messageDays(db: Db, o: DiaryOpts): string[] {
  const r = db.prepare('SELECT min(created_at) AS a, max(created_at) AS b FROM messages').get() as {
    a: string | null;
    b: string | null;
  };
  if (!r.a || !r.b) return [];
  const last = toLocalDate(r.b, o.cutoffHour, o.timeZone);
  const days: string[] = [];
  for (let d = toLocalDate(r.a, o.cutoffHour, o.timeZone); d <= last; d = addDays(d, 1)) days.push(d);
  return days;
}
