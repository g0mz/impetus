import { describe, expect, it } from 'vitest';
import { buildTurnPrompt } from '../../src/brain/context-builder.ts';
import { activeNotes, getNote, pruneNotes } from '../../src/db/repos/coach-notes.ts';
import { undoTurn } from '../../src/db/undo.ts';
import { runCommand } from '../../src/gateway/commands.ts';
import { buildRegistry } from '../../src/tools/index.ts';
import { SETTINGS, data, makeCaller, makeDb } from '../helpers.ts';

const NOW = '2026-10-21T13:00:00Z';
type NoteOut = { note_id: number; replaced_id?: number; observation_id?: number };

const prompt = (db: ReturnType<typeof makeDb>['db'], now = NOW) =>
  buildTurnPrompt(db, { now, settings: SETTINGS, userText: 'oi', images: [], recentTurns: 0 });

describe('tools de memória do coach (Fase 8b)', () => {
  it('remember_note valida due_date por tipo', () => {
    const { db } = makeDb();
    const { call } = makeCaller(db, { now: NOW });
    expect(call('remember_note', { kind: 'life_event', text: 'viagem a SP' })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION' },
    });
    expect(
      call('remember_note', { kind: 'preference', text: 'sem tendência', due_date: '2026-10-25' }),
    ).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    expect(
      call('remember_note', { kind: 'life_event', text: 'viagem a SP', due_date: '2026-11-01' }).ok,
    ).toBe(true);
  });

  it('replaces_id troca a preferência; desfazer o turno restaura a antiga', () => {
    const { db } = makeDb();
    const { call, newTurn } = makeCaller(db, { now: NOW });
    const a = data(call<NoteOut>('remember_note', { kind: 'preference', text: 'prefere respostas longas' }));
    const turn = newTurn();
    const b = data(
      call<NoteOut>('remember_note', {
        kind: 'preference',
        text: 'prefere respostas curtas',
        replaces_id: a.note_id,
      }),
    );
    expect(b.replaced_id).toBe(a.note_id);
    expect(activeNotes(db).map((n) => n.text)).toEqual(['prefere respostas curtas']);

    undoTurn(db, turn, NOW);
    expect(activeNotes(db).map((n) => n.text)).toEqual(['prefere respostas longas']);
  });

  it('resolve_note fecha o evento e guarda o desfecho como observação; só life_event', () => {
    const { db } = makeDb();
    const { call } = makeCaller(db, { now: NOW });
    const ev = data(
      call<NoteOut>('remember_note', { kind: 'life_event', text: 'joelho doendo', due_date: '2026-10-21' }),
    );
    const pref = data(call<NoteOut>('remember_note', { kind: 'preference', text: 'sem emoji demais' }));
    expect(call('resolve_note', { note_id: pref.note_id })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION' },
    });
    const r = data(
      call<NoteOut>('resolve_note', { note_id: ev.note_id, outcome: 'joelho melhorou em 21/10' }),
    );
    expect(getNote(db, ev.note_id)!.resolved_at).toBe(NOW);
    expect(getNote(db, r.observation_id!)).toMatchObject({
      kind: 'observation',
      text: 'joelho melhorou em 21/10',
    });
    expect(call('resolve_note', { note_id: ev.note_id })).toMatchObject({
      ok: false,
      error: { code: 'CONFLICT' },
    });
  });

  it('o bloco <coach_notes> entra no prompt com ids e "pergunte agora" no dia', () => {
    const { db } = makeDb();
    const { call } = makeCaller(db, { now: NOW });
    expect(prompt(db)).not.toContain('<coach_notes>');
    call('remember_note', { kind: 'preference', text: 'prefere respostas sem análise de tendência' });
    call('remember_note', { kind: 'life_event', text: 'viagem a SP até 31/10', due_date: '2026-11-01' });
    expect(prompt(db)).toContain('- [1] preferência: prefere respostas sem análise de tendência');
    expect(prompt(db)).not.toContain('viagem');
    expect(prompt(db, '2026-11-01T13:00:00Z')).toContain(
      '- [2] evento (pergunte agora): viagem a SP até 31/10',
    );
  });

  it('/notas lista por tipo e /esquecer apaga (com auditoria, desfazível)', () => {
    const { db } = makeDb();
    const { call } = makeCaller(db, { now: NOW });
    const ctx = { db, registry: buildRegistry(), settings: SETTINGS, now: NOW };
    expect(runCommand(ctx, 'notas', '').text).toMatch(/Ainda não guardei/);
    const n = data(call<NoteOut>('remember_note', { kind: 'preference', text: 'treina antes do trabalho' }));
    expect(runCommand(ctx, 'notas', '').text).toContain(`[${n.note_id}] treina antes do trabalho`);

    expect(runCommand(ctx, 'esquecer', 'abc').text).toMatch(/Uso/);
    expect(runCommand(ctx, 'esquecer', '99').text).toMatch(/não existe/);
    const r = runCommand(ctx, 'esquecer', `[${n.note_id}]`);
    expect(r.text).toContain('esquecida');
    expect(activeNotes(db)).toHaveLength(0);
    expect(runCommand(ctx, 'desfazer', '').text).toMatch(/nota do coach/);
    expect(activeNotes(db)).toHaveLength(1);
  });

  it('pruneNotes arquiva eventos resolvidos há 30+ dias e observações paradas há 90+ dias', () => {
    const { db } = makeDb();
    const { call, state } = makeCaller(db, { now: '2026-06-01T12:00:00Z' });
    const old = data(call<NoteOut>('remember_note', { kind: 'observation', text: 'treinava à noite' }));
    const pref = data(call<NoteOut>('remember_note', { kind: 'preference', text: 'respostas curtas' }));
    const ev = data(
      call<NoteOut>('remember_note', { kind: 'life_event', text: 'viagem', due_date: '2026-06-05' }),
    );
    call('resolve_note', { note_id: ev.note_id });
    state.now = NOW;
    const fresh = data(call<NoteOut>('remember_note', { kind: 'observation', text: 'treina de manhã' }));

    expect(pruneNotes(db, NOW)).toBe(2);
    const alive = db
      .prepare('SELECT id FROM coach_notes WHERE deleted_at IS NULL ORDER BY id')
      .pluck()
      .all() as number[];
    expect(alive).toEqual([pref.note_id, fresh.note_id]);
    expect(alive).not.toContain(old.note_id);
  });
});
