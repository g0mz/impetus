import { describe, expect, it } from 'vitest';
import { card, esc, page, rows, stat } from '../../src/dashboard/layout.ts';

describe('casca do dashboard', () => {
  const html = page({ title: 'Peso', active: 'peso', period: '30d', body: '<p>oi</p>' });

  it('declara idioma, tokens e os dois esquemas de cor', () => {
    expect(html).toContain('<html lang="pt-BR">');
    expect(html).toContain('--papel');
    expect(html).toContain('--dado');
    expect(html).toContain('prefers-color-scheme: dark');
    expect(html).toContain('<p>oi</p>');
  });

  it('não carrega JavaScript nenhum', () => {
    expect(html).not.toContain('<script');
    expect(html).not.toContain('onclick');
  });

  it('marca a aba e o período ativos sem depender só de cor', () => {
    expect(html).toContain('aria-current="page"');
    expect(html).toMatch(/<a href="\/peso\?p=30d" aria-current="true">30 dias<\/a>/);
    expect(html).toContain('border-top-color: var(--dado)');
  });

  it('leva o período nos links da navegação', () => {
    expect(html).toContain('href="/treino?p=30d"');
  });

  it('tem área de toque e foco visível', () => {
    expect(html).toContain('focus-visible');
    expect(html).toContain('padding: 13px 2px 11px');
  });
});

describe('escape', () => {
  it('escapa o que vem do usuário', () => {
    expect(esc('<img onerror=x>')).toBe('&lt;img onerror=x&gt;');
    expect(esc('aspas " e \'')).toBe('aspas &quot; e &#39;');
    expect(card('Supino <b>', '<svg/>')).toContain('Supino &lt;b&gt;');
    expect(card('t', '<svg/>')).toContain('<svg/>'); // corpo é HTML pronto
    expect(stat('rótulo', '82,4', 'kg')).toContain('<b>82,4</b>');
    expect(rows([['Supino <i>', '30 kg']])).toContain('Supino &lt;i&gt;');
  });

  it('marca o valor fora da meta com a classe semântica', () => {
    expect(stat('kcal', '3200', 'kcal', true)).toContain('class="stat fora"');
  });
});
