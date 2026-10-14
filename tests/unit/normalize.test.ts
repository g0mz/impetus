import { describe, expect, it } from 'vitest';
import { ftsPrefixQuery, normalize } from '../../src/text/normalize.ts';

describe('normalize', () => {
  it('remove acentos, caixa e pontuação; colapsa espaços', () => {
    expect(normalize('  Supino  Inclinado (Halter) ')).toBe('supino inclinado halter');
    expect(normalize('Feijão, carioca, cozido')).toBe('feijao carioca cozido');
    expect(normalize('Pão  de   Açúcar')).toBe('pao de acucar');
    expect(normalize('Leg press 45°')).toBe('leg press 45');
    expect(normalize('')).toBe('');
  });
});

describe('ftsPrefixQuery', () => {
  it('gera prefixos e corta terminação de gênero em palavras longas', () => {
    expect(ftsPrefixQuery('arroz cozido')).toBe('"arroz"* "cozid"*');
    expect(ftsPrefixQuery('sup inc')).toBe('"sup"* "inc"*');
    expect(ftsPrefixQuery('Frangos assados')).toBe('"frang"* "assad"*');
  });

  it('devolve null para consulta vazia ou só pontuação', () => {
    expect(ftsPrefixQuery('  ')).toBeNull();
    expect(ftsPrefixQuery('"*()')).toBeNull();
  });
});
