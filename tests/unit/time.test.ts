import { describe, expect, it } from 'vitest';
import {
  addDays,
  formatDateTimeBR,
  formatDayMonth,
  formatLocalIso,
  localDayBounds,
  toLocalDate,
  toUtcIso,
  weekdayPt,
  zonedTimeToUtc,
} from '../../src/time.ts';

describe('toLocalDate (America/Sao_Paulo, virada às 04:00)', () => {
  it('meia-noite local ainda pertence ao dia anterior', () => {
    expect(toLocalDate('2026-10-14T03:00:00Z')).toBe('2026-10-13'); // 00:00 local
    expect(toLocalDate('2026-10-14T02:59:59Z')).toBe('2026-10-13'); // 23:59 local
  });

  it('vira às 04:00 local', () => {
    expect(toLocalDate('2026-10-14T06:59:59Z')).toBe('2026-10-13'); // 03:59:59 local
    expect(toLocalDate('2026-10-14T07:00:00Z')).toBe('2026-10-14'); // 04:00 local
  });

  it('cutoff 0 usa a data de calendário', () => {
    expect(toLocalDate('2026-10-14T03:00:00Z', 0)).toBe('2026-10-14');
  });

  it('vira o ano e o mês corretamente', () => {
    expect(toLocalDate('2027-01-01T05:30:00Z')).toBe('2026-12-31'); // 02:30 local
    expect(toLocalDate('2026-03-01T06:00:00Z')).toBe('2026-02-28'); // 03:00 local
  });

  // Horário de verão histórico (2018/2019): o código não presume ausência de DST.
  it('início do horário de verão (04/11/2018, 00:00 → 01:00)', () => {
    expect(toLocalDate('2018-11-04T02:59:00Z')).toBe('2018-11-03'); // 23:59 -03
    expect(toLocalDate('2018-11-04T03:00:00Z')).toBe('2018-11-03'); // 01:00 -02, antes do cutoff
    expect(toLocalDate('2018-11-04T05:59:00Z')).toBe('2018-11-03'); // 03:59 -02
    expect(toLocalDate('2018-11-04T06:00:00Z')).toBe('2018-11-04'); // 04:00 -02
  });

  it('fim do horário de verão (17/02/2019, 00:00 → 23:00 do dia 16)', () => {
    expect(toLocalDate('2019-02-17T01:59:00Z')).toBe('2019-02-16'); // 23:59 -02
    expect(toLocalDate('2019-02-17T02:00:00Z')).toBe('2019-02-16'); // 23:00 -03 (repetida)
    expect(toLocalDate('2019-02-17T06:59:00Z')).toBe('2019-02-16'); // 03:59 -03
    expect(toLocalDate('2019-02-17T07:00:00Z')).toBe('2019-02-17'); // 04:00 -03
  });

  it('respeita outro fuso', () => {
    expect(toLocalDate('2026-10-14T03:30:00Z', 4, 'UTC')).toBe('2026-10-13');
    expect(toLocalDate('2026-10-14T04:00:00Z', 4, 'UTC')).toBe('2026-10-14');
  });

  it('rejeita data inválida', () => {
    expect(() => toLocalDate('ontem')).toThrow(RangeError);
  });
});

describe('localDayBounds / zonedTimeToUtc', () => {
  it('dia contábil normal vai de 04:00 a 04:00 locais', () => {
    expect(localDayBounds('2026-10-13')).toEqual({
      start: '2026-10-13T07:00:00Z',
      end: '2026-10-14T07:00:00Z',
    });
  });

  it('dia com início do horário de verão tem 23 h', () => {
    // 03/11/2018 04:00 -03 → 04/11/2018 04:00 -02
    expect(localDayBounds('2018-11-03')).toEqual({
      start: '2018-11-03T07:00:00Z',
      end: '2018-11-04T06:00:00Z',
    });
  });

  it('dia com fim do horário de verão tem 25 h', () => {
    expect(localDayBounds('2019-02-16')).toEqual({
      start: '2019-02-16T06:00:00Z',
      end: '2019-02-17T07:00:00Z',
    });
  });

  it('horário inexistente (salto do DST) cai no primeiro instante válido', () => {
    // 04/11/2018 00:00 não existiu em São Paulo; 01:00 -02 = 03:00Z
    expect(toUtcIso(zonedTimeToUtc('2018-11-04', 0))).toBe('2018-11-04T03:00:00Z');
  });

  it('toLocalDate do início do intervalo devolve o próprio dia', () => {
    for (const d of ['2026-10-13', '2018-11-03', '2018-11-04', '2019-02-16', '2019-02-17']) {
      const { start, end } = localDayBounds(d);
      expect(toLocalDate(start)).toBe(d);
      expect(toLocalDate(new Date(new Date(end).getTime() - 1000))).toBe(d);
    }
  });
});

describe('formatação pt-BR', () => {
  it('formata datas e horas', () => {
    expect(formatDayMonth('2026-10-08')).toBe('08/10');
    expect(formatDateTimeBR('2026-10-13T23:41:00Z')).toBe('13/10 20:41');
    expect(weekdayPt('2026-10-13')).toBe('terça');
    expect(formatLocalIso('2026-10-13T23:41:00Z')).toBe('2026-10-13T20:41:00-03:00');
    expect(formatLocalIso('2018-12-01T12:00:00Z')).toBe('2018-12-01T10:00:00-02:00');
  });

  it('addDays e toUtcIso', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2024-03-01', -1)).toBe('2024-02-29');
    expect(toUtcIso('2026-10-13T20:41:00.123-03:00')).toBe('2026-10-13T23:41:00Z');
  });
});

describe('resolveWhen: hora sem fuso é hora local do usuário', () => {
  it('2026-10-14T18:15 em São Paulo = 21:15Z, independente do fuso do servidor', async () => {
    const { resolveWhen } = await import('../../src/time.ts');
    expect(resolveWhen('2026-10-14T18:15', '2026-10-15T05:00:00Z', 4, 'America/Sao_Paulo')).toEqual({
      at: '2026-10-14T21:15:00Z',
      localDate: '2026-10-14',
    });
    expect(resolveWhen('2026-10-15T01:30:00', '2026-10-15T05:00:00Z', 4, 'America/Sao_Paulo').localDate).toBe(
      '2026-10-14',
    );
    expect(resolveWhen('2026-10-14T18:15:00Z', '2026-10-15T05:00:00Z').at).toBe('2026-10-14T18:15:00Z');
  });
});
