/**
 * Normaliza texto para chaves e buscas: minúsculas, sem acentos, pontuação vira espaço,
 * espaços colapsados. Ex.: "Supino  Inclinado (Halter)" → "supino inclinado halter".
 */
export function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Termos exatos para FTS5 (todas as palavras, sem prefixo). */
export function ftsExactQuery(text: string): string | null {
  const terms = normalize(text).split(' ').filter(Boolean);
  return terms.length ? terms.map((t) => `"${t}"`).join(' ') : null;
}

/**
 * Termos de busca para FTS5: cada palavra vira prefixo entre aspas. Palavras com 5+ letras
 * terminadas em vogal de gênero/número perdem a terminação ("cozido" → "cozid"*), para casar
 * cozido/cozida, frito/frita, assado/assados.
 */
export function ftsPrefixQuery(text: string): string | null {
  const terms = normalize(text)
    .split(' ')
    .filter(Boolean)
    .map((t) => (t.length >= 5 ? t.replace(/(os|as|o|a)$/, '') : t))
    .map((t) => `"${t.replace(/"/g, '')}"*`);
  return terms.length ? terms.join(' ') : null;
}
