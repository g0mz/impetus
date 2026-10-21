import { describe, expect, it } from 'vitest';
import { notesForContext, type CoachNote } from '../../src/domain/coach/notes.ts';

const TODAY = '2026-10-21';
const pref = (id: number, text = 'prefere respostas curtas'): CoachNote => ({
  id,
  kind: 'preference',
  text,
  due_local_date: null,
});
const obs = (id: number, text = `observação ${id}`): CoachNote => ({
  id,
  kind: 'observation',
  text,
  due_local_date: null,
});
const event = (id: number, due: string, text = `evento ${id}`): CoachNote => ({
  id,
  kind: 'life_event',
  text,
  due_local_date: due,
});

describe('notesForContext', () => {
  it('preferências sempre; evento só a até 2 dias da data; vencido vira "pergunte agora"', () => {
    const lines = notesForContext(
      [pref(1), event(2, '2026-10-20'), event(3, '2026-10-23'), event(4, '2026-10-24'), obs(5)],
      TODAY,
    );
    expect(lines).toEqual([
      '- [1] preferência: prefere respostas curtas',
      '- [2] evento (pergunte agora): evento 2',
      '- [3] evento (perguntar a partir de 23/10): evento 3',
      '- [5] observação: observação 5',
    ]);
  });

  it('eventos em ordem de data; observações mais recentes primeiro', () => {
    const lines = notesForContext([obs(1), obs(2), event(3, '2026-10-22'), event(4, '2026-10-19')], TODAY);
    expect(lines.map((l) => /\[(\d+)\]/.exec(l)![1])).toEqual(['4', '3', '2', '1']);
  });

  it('acima do orçamento corta primeiro as observações mais antigas, nunca preferências', () => {
    const long = 'x'.repeat(150);
    const notes = [pref(1, long), pref(2, long), ...Array.from({ length: 10 }, (_, i) => obs(10 + i, long))];
    const lines = notesForContext(notes, TODAY, 700);
    expect(lines.join('\n').length).toBeLessThanOrEqual(700);
    expect(lines.slice(0, 2).every((l) => l.includes('preferência'))).toBe(true);
    expect(lines.at(-1)).toContain('[18]');
    expect(lines.some((l) => l.includes('[10]'))).toBe(false);
  });

  it('sem notas, sem linhas', () => {
    expect(notesForContext([], TODAY)).toEqual([]);
  });
});
