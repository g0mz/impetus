import { describe, expect, it } from 'vitest';
import { plannedFor, plannedWeek, type PlanOverride } from '../../src/domain/training/schedule.ts';
import { weekdayIndex } from '../../src/time.ts';

const upperA = { id: 1, name: 'Upper A' };
const lowerA = { id: 2, name: 'Lower A' };
const upperB = { id: 3, name: 'Upper B' };
// seg upper A, ter lower A, qui upper B (2026-10-19 é segunda)
const schedule = new Map([
  [1, upperA],
  [2, lowerA],
  [4, upperB],
]);

const ov = (
  id: number,
  from: string,
  until: string,
  changes: [number, typeof upperA | null][] | null,
  text = `ajuste ${id}`,
): PlanOverride => ({
  id,
  from_local_date: from,
  until_local_date: until,
  text,
  weekday_changes: changes ? new Map(changes) : null,
});

describe('weekdayIndex', () => {
  it('0 = domingo; independe de fuso', () => {
    expect(weekdayIndex('2026-10-18')).toBe(0);
    expect(weekdayIndex('2026-10-19')).toBe(1);
    expect(weekdayIndex('2026-10-24')).toBe(6);
  });
});

describe('plannedFor', () => {
  it('agenda normal; dia fora da agenda é descanso; sem agenda, source none', () => {
    expect(plannedFor('2026-10-19', schedule, [])).toMatchObject({ routine: upperA, source: 'schedule' });
    expect(plannedFor('2026-10-21', schedule, [])).toMatchObject({ routine: null, source: 'schedule' });
    expect(plannedFor('2026-10-19', new Map(), [])).toMatchObject({ routine: null, source: 'none' });
  });

  it('ajuste move a sessão só dentro do período e informa o texto', () => {
    // upper B sai da quinta e vai para a sexta nesta semana
    const moved = ov(
      1,
      '2026-10-19',
      '2026-10-25',
      [
        [4, null],
        [5, upperB],
      ],
      'upper B na sexta',
    );
    expect(plannedFor('2026-10-22', schedule, [moved])).toMatchObject({ routine: null, source: 'override' });
    expect(plannedFor('2026-10-23', schedule, [moved])).toMatchObject({
      routine: upperB,
      source: 'override',
      overrides: [{ id: 1, text: 'upper B na sexta' }],
    });
    expect(plannedFor('2026-10-29', schedule, [moved])).toMatchObject({
      routine: upperB,
      source: 'schedule',
    });
  });

  it('ajuste só informativo não muda a sessão; o mais recente vence no mesmo dia', () => {
    const hotel = ov(1, '2026-10-26', '2026-10-30', null, 'só academia de hotel');
    const rest = ov(2, '2026-10-26', '2026-10-27', [[1, null]]);
    const back = ov(3, '2026-10-26', '2026-10-26', [[1, lowerA]]);
    const d = plannedFor('2026-10-26', schedule, [back, hotel, rest]);
    expect(d.routine).toEqual(lowerA);
    expect(d.overrides.map((o) => o.id)).toEqual([1, 2, 3]);
    expect(plannedFor('2026-10-27', schedule, [hotel])).toMatchObject({
      routine: lowerA,
      source: 'schedule',
    });
  });
});

describe('plannedWeek', () => {
  it('7 dias a partir da data, com ajustes', () => {
    const w = plannedWeek('2026-10-19', schedule, [ov(1, '2026-10-20', '2026-10-20', [[2, null]])]);
    expect(w.map((d) => d.routine?.name ?? '—')).toEqual(['Upper A', '—', '—', 'Upper B', '—', '—', '—']);
  });
});
