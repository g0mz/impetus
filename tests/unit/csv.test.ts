import { describe, expect, it } from 'vitest';
import { parseCsv, parseCsvObjects } from '../../src/seeds/csv.ts';

describe('parseCsv', () => {
  it('lida com aspas, vírgulas, aspas escapadas e CRLF', () => {
    expect(parseCsv('a,b\r\n"Arroz, tipo 1",2\n"diz ""oi""",\n')).toEqual([
      ['a', 'b'],
      ['Arroz, tipo 1', '2'],
      ['diz "oi"', ''],
    ]);
  });

  it('remove BOM e linhas vazias finais', () => {
    expect(parseCsv('﻿x\n1\n\n')).toEqual([['x'], ['1']]);
  });

  it('falha com aspas não fechadas', () => {
    expect(() => parseCsv('"abc')).toThrow(/aspas/);
  });
});

describe('parseCsvObjects', () => {
  it('mapeia pelo cabeçalho e valida o número de colunas', () => {
    expect(parseCsvObjects('id,name\n1,"Ovo, cozido"\n')).toEqual([{ id: '1', name: 'Ovo, cozido' }]);
    expect(() => parseCsvObjects('id,name\n1\n')).toThrow(/linha 2/);
  });
});
