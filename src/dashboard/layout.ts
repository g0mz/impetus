import { dash } from '../i18n/pt-br.ts';

export type Nav = 'resumo' | 'peso' | 'nutricao' | 'treino' | 'exercicio' | 'sono';
export type PeriodKey = '7d' | '30d' | '90d' | 'ano';
export const PERIODS: PeriodKey[] = ['7d', '30d', '90d', 'ano'];

export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Direção visual: registro de medição. Números em fonte tabular, faixa de meta como gramática
 * compartilhada, nada de moldura de cartão (borda come largura em celular).
 */
const CSS = `
:root {
  --papel: #FBFAF7; --tinta: #16181B; --dado: #1F3A5F;
  --meta: #C3D1B4; --fora: #B4532A; --fraca: #8A8F98;
  --linha: color-mix(in srgb, var(--fraca) 30%, transparent);
}
@media (prefers-color-scheme: dark) {
  :root {
    --papel: #16181B; --tinta: #F2F0EC; --dado: #8FB4E0;
    --meta: #4A5C3C; --fora: #E08A5F; --fraca: #8A8F98;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 0 16px 72px; background: var(--papel); color: var(--tinta);
  font: 15px/1.5 "IBM Plex Sans", system-ui, sans-serif;
  -webkit-text-size-adjust: 100%;
}
header { display: flex; align-items: baseline; gap: 12px; padding: 16px 0 8px; }
header h1 {
  margin: 0; font: 600 13px/1 "IBM Plex Sans Condensed", system-ui, sans-serif;
  letter-spacing: .14em; text-transform: uppercase; color: var(--fraca);
}
header h1 a { color: inherit; text-decoration: none; }
nav.periodo { margin-left: auto; display: flex; gap: 2px; }
nav.periodo a {
  font: 12px/1 "IBM Plex Sans Condensed", system-ui, sans-serif; color: var(--fraca);
  text-decoration: none; padding: 5px 7px; border-radius: 3px;
}
nav.periodo a[aria-current="true"] { color: var(--papel); background: var(--dado); }
section { padding: 18px 0; border-top: 1px solid var(--linha); }
section:first-of-type { border-top: 0; }
h2 {
  margin: 0 0 10px; font: 600 12px/1 "IBM Plex Sans Condensed", system-ui, sans-serif;
  letter-spacing: .1em; text-transform: uppercase; color: var(--fraca);
}
.stat { display: flex; align-items: baseline; gap: 8px; margin: 0 0 6px; }
.stat b {
  font: 400 32px/1 "IBM Plex Mono", ui-monospace, monospace;
  font-variant-numeric: tabular-nums; letter-spacing: -.02em;
}
.stat .unidade { font-size: 13px; color: var(--fraca); }
.stat .rotulo {
  margin-left: auto; font: 12px/1 "IBM Plex Sans Condensed", system-ui, sans-serif;
  text-transform: uppercase; letter-spacing: .08em; color: var(--fraca);
}
.fora b { color: var(--fora); }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
td { padding: 5px 0; border-bottom: 1px solid var(--linha); }
td:last-child {
  text-align: right; font-family: "IBM Plex Mono", ui-monospace, monospace;
  font-variant-numeric: tabular-nums;
}
svg { max-width: 100%; height: auto; display: block; }
p.vazio { margin: 0; color: var(--fraca); font-size: 14px; }
form.seletor { display: flex; gap: 8px; margin: 0 0 14px; }
select, button {
  font: 14px "IBM Plex Sans", system-ui, sans-serif; color: var(--tinta);
  background: var(--papel); border: 1px solid var(--linha); border-radius: 4px; padding: 7px 9px;
}
button { background: var(--dado); color: var(--papel); border-color: var(--dado); }
nav.abas {
  position: fixed; inset: auto 0 0 0; display: flex; background: var(--papel);
  border-top: 1px solid var(--linha); padding: 0 8px;
}
nav.abas a {
  flex: 1; text-align: center; padding: 13px 2px 11px; text-decoration: none; color: var(--fraca);
  font: 12px/1 "IBM Plex Sans Condensed", system-ui, sans-serif; text-transform: uppercase;
  letter-spacing: .06em; border-top: 2px solid transparent; margin-top: -1px;
}
nav.abas a[aria-current="page"] { color: var(--tinta); border-top-color: var(--dado); }
a:focus-visible, button:focus-visible, select:focus-visible {
  outline: 2px solid var(--dado); outline-offset: 2px;
}
`;

export function stat(label: string, value: string, unit?: string, fora = false): string {
  return `<p class="stat${fora ? ' fora' : ''}"><b>${esc(value)}</b>${
    unit ? `<span class="unidade">${esc(unit)}</span>` : ''
  }<span class="rotulo">${esc(label)}</span></p>`;
}

/** `body` é HTML já montado (gráfico, tabela); `title` é texto e vai escapado. */
export function card(title: string, body: string): string {
  return `<section><h2>${esc(title)}</h2>${body}</section>`;
}

export function rows(pairs: [string, string][]): string {
  return `<table>${pairs.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table>`;
}

const NAV: [Nav, string, string][] = [
  ['peso', '/peso', dash.nav.peso],
  ['nutricao', '/nutricao', dash.nav.nutricao],
  ['treino', '/treino', dash.nav.treino],
  ['exercicio', '/exercicio', dash.nav.exercicio],
  ['sono', '/sono', dash.nav.sono],
];

export function page(opts: {
  title: string;
  active: Nav;
  period: PeriodKey;
  body: string;
  path?: string;
}): string {
  const path = opts.path ?? (opts.active === 'resumo' ? '/' : `/${opts.active}`);
  const periodos = PERIODS.map(
    (p) =>
      `<a href="${path}?p=${p}"${p === opts.period ? ' aria-current="true"' : ''}>${esc(
        dash.periodo[p],
      )}</a>`,
  ).join('');
  const abas = NAV.map(
    ([key, href, label]) =>
      `<a href="${href}?p=${opts.period}"${
        key === opts.active ? ' aria-current="page"' : ''
      }>${esc(label)}</a>`,
  ).join('');
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${esc(opts.title)} · ${esc(dash.app)}</title>
<style>${CSS}</style>
</head>
<body>
<header><h1><a href="/?p=${opts.period}">${esc(dash.app)}</a></h1><nav class="periodo">${periodos}</nav></header>
<main>${opts.body}</main>
<nav class="abas">${abas}</nav>
</body>
</html>`;
}
