# Dashboard de visualização — plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Seis páginas somente leitura, servidas pela própria VM na tailnet, para explorar peso, nutrição, treino, um exercício específico e sono/atividade.

**Architecture:** Um app hono novo em `src/dashboard/`, escutando só em `127.0.0.1:8789`, atravessado pelo `tailscale serve`. As páginas são funções puras `dados → HTML`; os números vêm de `buildReportBrief` e `domain/metrics/*`, já existentes; os gráficos vêm do pipeline Vega-Lite de `src/charts/`, parando no SVG em vez de rasterizar para PNG. Cache em memória invalidado por escrita. Zero JavaScript no cliente.

**Tech Stack:** Node 24 ESM, TypeScript estrito, hono + @hono/node-server, vega + vega-lite (já instalados), better-sqlite3, vitest.

**Spec:** `docs/superpowers/specs/2026-10-17-dashboard-design.md`

## Global Constraints

- Textos ao usuário em PT-BR, centralizados em `src/i18n/pt-br.ts`; nomes de código em inglês.
- Nenhuma rota escreve no banco. `buildReportBrief` é chamado com `{ persist: false }`.
- `domain/` sem I/O de rede; SQL só em `src/db/repos/`.
- Servidor só em `127.0.0.1`; porta `DASHBOARD_PORT=8789`; tudo atrás de `DASHBOARD=false` por padrão.
- Datas agregadas por `local_date` via `src/time.ts` (fuso America/Sao_Paulo, virada às `DAY_CUTOFF_HOUR`).
- Tokens de cor: `--papel #FBFAF7` · `--tinta #16181B` · `--dado #1F3A5F` · `--meta #C3D1B4` · `--fora #B4532A` · `--fraca #8A8F98`.
- Períodos aceitos: `7d`, `30d` (padrão), `90d`, `ano`.
- `npm run check` verde antes de cada commit.

---

### Task 1: Flags de configuração

**Files:**
- Modify: `src/config.ts` (schema zod)
- Modify: `runtime/.env.example`
- Test: `tests/unit/config.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces: `Config.DASHBOARD: boolean`, `Config.DASHBOARD_PORT: number`.

- [ ] **Step 1: Write the failing test**

```ts
it('dashboard vem desligado e na porta 8789', () => {
  const c = loadConfig({ ...baseEnv });
  expect(c.DASHBOARD).toBe(false);
  expect(c.DASHBOARD_PORT).toBe(8789);
});

it('aceita ligar o dashboard', () => {
  const c = loadConfig({ ...baseEnv, DASHBOARD: 'true', DASHBOARD_PORT: '9000' });
  expect(c.DASHBOARD).toBe(true);
  expect(c.DASHBOARD_PORT).toBe(9000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/config.test.ts`
Expected: FAIL — `DASHBOARD` não existe no tipo `Config`.

- [ ] **Step 3: Write minimal implementation**

No objeto do schema, junto de `INGEST_PORT`:

```ts
    DASHBOARD: bool.default(false),
    DASHBOARD_PORT: int(8789),
```

Em `runtime/.env.example`, depois de `INGEST_PORT`:

```
# Dashboard somente leitura (exposto na tailnet via `tailscale serve`; DEPLOY.md §6)
DASHBOARD=false
DASHBOARD_PORT=8789
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/config.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config.ts runtime/.env.example tests/unit/config.test.ts
git commit -m "feat(dashboard): DASHBOARD and DASHBOARD_PORT flags"
```

---

### Task 2: SVG em memória e tokenização de cor

**Files:**
- Modify: `src/charts/render.ts`
- Test: `tests/unit/charts-svg.test.ts` (criar)

**Interfaces:**
- Consumes: `renderChart` existente (que já faz `view.toSVG()` por dentro).
- Produces: `renderChartSvg(spec: TopLevelSpec): Promise<string>` e `tokenizeSvg(svg: string): string`.

`tokenizeSvg` existe porque `var()` **não** resolve em atributo de apresentação (`fill="var(--dado)"` é inválido), mas resolve dentro de `style`. Ela troca cada hex conhecido por uma declaração em `style`.

- [ ] **Step 1: Write the failing test**

```ts
import { renderChartSvg, tokenizeSvg, WEB_HEX_TO_TOKEN } from '../../src/charts/render.ts';
import { stepsSpec } from '../../src/charts/specs.ts';

describe('tokenizeSvg', () => {
  it('troca hex conhecido por var() dentro de style', () => {
    const out = tokenizeSvg('<rect fill="#1F3A5F"/><path style="stroke: #b4532a;"/>');
    expect(out).toContain('style="fill:var(--dado)"');
    expect(out).toContain('stroke:var(--fora)');
    expect(out).not.toMatch(/#1f3a5f/i);
    expect(out).not.toMatch(/#b4532a/i);
  });

  it('não sobra hex do sistema de cor no SVG renderizado', async () => {
    const svg = await renderChartSvg(stepsSpec([{ local_date: '2026-10-16', steps: 11267 }], 8000));
    for (const hex of Object.keys(WEB_HEX_TO_TOKEN)) {
      expect(svg.toLowerCase()).not.toContain(hex.toLowerCase());
    }
    expect(svg).toContain('<svg');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/charts-svg.test.ts`
Expected: FAIL — `renderChartSvg` / `tokenizeSvg` / `WEB_HEX_TO_TOKEN` não existem.

- [ ] **Step 3: Write minimal implementation**

Em `src/charts/render.ts`:

```ts
/** Hex dos tokens web → variável CSS. A tokenização permite modo escuro sem re-renderizar. */
export const WEB_HEX_TO_TOKEN: Record<string, string> = {
  '#fbfaf7': '--papel',
  '#16181b': '--tinta',
  '#1f3a5f': '--dado',
  '#c3d1b4': '--meta',
  '#b4532a': '--fora',
  '#8a8f98': '--fraca',
};

/** Vega-Lite → SVG (vega, sem canvas). Sem rasterizar: o dashboard serve o SVG inline. */
export async function renderChartSvg(spec: TopLevelSpec): Promise<string> {
  const view = new vega.View(vega.parse(compile(spec).spec), { renderer: 'none' });
  const svg = await view.toSVG();
  view.finalize();
  return tokenizeSvg(svg);
}

/** `var()` só resolve em `style`, não em atributo de apresentação. */
export function tokenizeSvg(svg: string): string {
  let out = svg.replace(
    /(fill|stroke)="(#[0-9a-fA-F]{6})"/g,
    (m, prop: string, hex: string) => {
      const token = WEB_HEX_TO_TOKEN[hex.toLowerCase()];
      return token ? `style="${prop}:var(${token})"` : m;
    },
  );
  for (const [hex, token] of Object.entries(WEB_HEX_TO_TOKEN)) {
    out = out.replaceAll(new RegExp(hex, 'gi'), `var(${token})`);
  }
  return out;
}
```

E `renderChart` passa a reaproveitar o SVG, sem duplicar o pipeline (o PNG do relatório não quer tokens, então
renderiza antes da tokenização):

```ts
export async function renderChart(spec: TopLevelSpec, outDir: string): Promise<string> {
  const view = new vega.View(vega.parse(compile(spec).spec), { renderer: 'none' });
  const svg = await view.toSVG();
  view.finalize();
  // ...resto igual (Resvg, write, return file)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/charts-svg.test.ts tests/integration/charts.test.ts`
Expected: PASS (o segundo garante que os gráficos do relatório não regrediram)

- [ ] **Step 5: Commit**

```bash
git add src/charts/render.ts tests/unit/charts-svg.test.ts
git commit -m "feat(charts): renderChartSvg with CSS-variable tokenization"
```

---

### Task 3: Tema web e os três specs novos

**Files:**
- Modify: `src/charts/specs.ts`
- Test: `tests/unit/charts-web-specs.test.ts` (criar)

**Interfaces:**
- Consumes: `WEB_HEX_TO_TOKEN` (Task 2) só como referência de valor; os specs escrevem os hex literais.
- Produces:
  - `kcalProteinSpec(rows: { local_date: string; kcal: number; protein_g: number }[], goals: { kcal?: number; protein_g?: number }): TopLevelSpec`
  - `stepsSpec(rows: { local_date: string; steps: number }[], goal?: number): TopLevelSpec`
  - `sleepSpec(rows: { local_date: string; hours: number }[], goalH?: number): TopLevelSpec`
  - `WEB_THEME` (largura 360, fonte do sistema, cores dos tokens)

O tema de relatório (`THEME`, 1000 px, fundo escuro) fica intacto: ele serve o PNG do WhatsApp.

- [ ] **Step 1: Write the failing test**

```ts
it('kcal e proteína vêm com a faixa de meta quando há meta', () => {
  const spec = kcalProteinSpec(
    [{ local_date: '2026-10-16', kcal: 2180, protein_g: 142 }],
    { kcal: 2300, protein_g: 160 },
  ) as { layer: unknown[] };
  expect(spec.layer.length).toBeGreaterThanOrEqual(2); // faixa + barras
  expect(JSON.stringify(spec)).toContain('#C3D1B4'); // token --meta
});

it('sem meta, não desenha faixa', () => {
  const spec = kcalProteinSpec([{ local_date: '2026-10-16', kcal: 2180, protein_g: 142 }], {}) as {
    layer: unknown[];
  };
  expect(JSON.stringify(spec)).not.toContain('#C3D1B4');
});

it('passos usam a largura web, não a do relatório', () => {
  const spec = stepsSpec([{ local_date: '2026-10-16', steps: 11267 }], 8000) as { width: number };
  expect(spec.width).toBe(360);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/charts-web-specs.test.ts`
Expected: FAIL — funções não existem.

- [ ] **Step 3: Write minimal implementation**

Em `src/charts/specs.ts`, depois do `THEME`:

```ts
const WEB_WIDTH = 360;
export const WEB_THEME: Pick<TopLevelSpec, 'background' | 'padding' | 'config'> = {
  background: '#FBFAF7',
  padding: 8,
  config: {
    font: 'system-ui, sans-serif',
    view: { stroke: null },
    locale: { number: { decimal: ',', thousands: '.', grouping: [3], currency: ['R$ ', ''] } },
    axis: {
      labelColor: '#8A8F98',
      titleColor: '#8A8F98',
      gridColor: '#8A8F98',
      gridOpacity: 0.15,
      domainColor: '#8A8F98',
      tickColor: '#8A8F98',
      labelFontSize: 11,
      titleFontSize: 11,
    },
    legend: { labelColor: '#16181B', labelFontSize: 11, titleColor: '#8A8F98' },
  },
};

/** Faixa de meta: elemento-assinatura, a mesma gramática em todo gráfico. */
function goalBand(goal: number, tolerance = 0.05) {
  return {
    mark: { type: 'rect' as const, fill: '#C3D1B4', opacity: 0.55 },
    data: { values: [{ lo: goal * (1 - tolerance), hi: goal * (1 + tolerance) }] },
    encoding: { y: { field: 'lo', type: 'quantitative' as const }, y2: { field: 'hi' } },
  };
}
```

E as três funções, cada uma com `...WEB_THEME`, `width: WEB_WIDTH`, barras/linha em `#1F3A5F` e a camada de
`goalBand` incluída só quando a meta existe. Exemplo completo de `stepsSpec`:

```ts
export function stepsSpec(rows: { local_date: string; steps: number }[], goal?: number): TopLevelSpec {
  return {
    ...WEB_THEME,
    width: WEB_WIDTH,
    height: 140,
    data: { values: noon(rows) },
    layer: [
      ...(goal ? [goalBand(goal)] : []),
      {
        mark: { type: 'bar', fill: '#1F3A5F', cornerRadiusEnd: 2 },
        encoding: {
          x: { field: 'local_date', type: 'temporal', axis: { format: '%d/%m', title: null } },
          y: { field: 'steps', type: 'quantitative', axis: { title: null } },
        },
      },
    ],
  } as TopLevelSpec;
}
```

`kcalProteinSpec` segue o mesmo molde com `repeat`/duas camadas de barra (kcal e proteína, uma meta cada);
`sleepSpec` igual, com `hours` no eixo y e meta em horas.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/charts-web-specs.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/charts/specs.ts tests/unit/charts-web-specs.test.ts
git commit -m "feat(charts): web theme and kcal/steps/sleep specs with the goal band"
```

---

### Task 4: `buildReportBrief` sem escrever

**Files:**
- Modify: `src/reports/build.ts:147` (assinatura) e `:240` (a escrita)
- Test: `tests/integration/reports.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces: `buildReportBrief(db, kind, period, now, opts?: { persist?: boolean })` — `persist` padrão `true`.

A linha 240 grava `metrics.maintenance_estimate` em `settings` sempre que `kind !== 'daily'`. Sem esta tarefa, cada
carregamento de página seria uma escrita no banco.

- [ ] **Step 1: Write the failing test**

```ts
it('persist:false não escreve a estimativa de manutenção', () => {
  const db = seededDb(); // helper já usado no arquivo
  const before = getSetting(db, 'metrics.maintenance_estimate');
  buildReportBrief(db, 'adhoc', { start: '2026-10-01', end: '2026-10-17' }, '2026-10-17T12:00:00Z', {
    persist: false,
  });
  expect(getSetting(db, 'metrics.maintenance_estimate')).toEqual(before);
});

it('por padrão continua persistindo (relatório semanal)', () => {
  const db = seededDb();
  buildReportBrief(db, 'weekly', { start: '2026-10-11', end: '2026-10-17' }, '2026-10-17T12:00:00Z');
  expect(getSetting(db, 'metrics.maintenance_estimate')).not.toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integration/reports.test.ts`
Expected: FAIL — o quinto argumento não existe; o primeiro teste vê a escrita acontecer.

- [ ] **Step 3: Write minimal implementation**

```ts
export function buildReportBrief(
  db: Db,
  kind: ReportKind,
  period: Period,
  now: string,
  opts: { persist?: boolean } = {},
): ReportBrief {
```

e a linha da escrita:

```ts
  if (opts.persist !== false && kind !== 'daily' && maintenance !== null)
    setSetting(db, 'metrics.maintenance_estimate', maintenance);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/integration/reports.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/reports/build.ts tests/integration/reports.test.ts
git commit -m "feat(reports): optional persistence in buildReportBrief for read-only callers"
```

---

### Task 5: Exercícios treinados num período

**Files:**
- Modify: `src/db/repos/training.ts`
- Test: `tests/integration/tools-training.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces: `trainedExercises(db, from: string, to: string): { id: number; name_pt: string; sessions: number }[]`

As séries da tela de exercício **não** precisam de SQL novo: `exerciseSessions(db, id, 200)` já devolve sessões com
séries, e o filtro de período é feito em memória (um usuário, poucas centenas de sessões).

- [ ] **Step 1: Write the failing test**

```ts
it('lista exercícios treinados no período, do mais frequente ao menos', () => {
  const db = dbWithSessions(); // helper do arquivo: sessões em 2026-10-14 e 2026-10-16
  const rows = trainedExercises(db, '2026-10-14', '2026-10-17');
  expect(rows[0]).toMatchObject({ name_pt: expect.any(String), sessions: expect.any(Number) });
  expect(rows.every((r) => r.sessions >= 1)).toBe(true);
  expect(trainedExercises(db, '2026-01-01', '2026-01-31')).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integration/tools-training.test.ts`
Expected: FAIL — `trainedExercises` não existe.

- [ ] **Step 3: Write minimal implementation**

```ts
/** Exercícios com séries no período, para o seletor do dashboard. */
export function trainedExercises(
  db: Db,
  from: string,
  to: string,
): { id: number; name_pt: string; sessions: number }[] {
  return db
    .prepare(
      `SELECT e.id, e.name_pt, count(DISTINCT ws.id) AS sessions
         FROM sets s
         JOIN workout_sessions ws ON ws.id = s.session_id AND ws.deleted_at IS NULL
         JOIN exercises e ON e.id = s.exercise_id
        WHERE s.deleted_at IS NULL AND ws.local_date BETWEEN ? AND ?
        GROUP BY e.id ORDER BY sessions DESC, e.name_pt`,
    )
    .all(from, to) as { id: number; name_pt: string; sessions: number }[];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/integration/tools-training.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/db/repos/training.ts tests/integration/tools-training.test.ts
git commit -m "feat(db): list exercises trained in a period"
```

---

### Task 6: Casca HTML, tokens e navegação

**Files:**
- Create: `src/dashboard/layout.ts`
- Modify: `src/i18n/pt-br.ts`
- Test: `tests/unit/dashboard-layout.test.ts` (criar)

**Interfaces:**
- Consumes: nada.
- Produces:
  - `page(opts: { title: string; active: Nav; period: PeriodKey; body: string }): string`
  - `type Nav = 'resumo' | 'peso' | 'nutricao' | 'treino' | 'exercicio' | 'sono'`
  - `type PeriodKey = '7d' | '30d' | '90d' | 'ano'`
  - `esc(s: string): string` (escapa `& < > " '`)
  - `card(title: string, body: string): string`, `stat(label: string, value: string, unit?: string): string`

- [ ] **Step 1: Write the failing test**

```ts
it('monta a casca com tokens, lang pt-BR e a aba ativa marcada', () => {
  const html = page({ title: 'Peso', active: 'peso', period: '30d', body: '<p>oi</p>' });
  expect(html).toContain('<html lang="pt-BR">');
  expect(html).toContain('--papel');
  expect(html).toContain('prefers-color-scheme: dark');
  expect(html).toContain('aria-current="page"');
  expect(html).toContain('<p>oi</p>');
  expect(html).not.toContain('<script'); // zero JS
});

it('escapa conteúdo do usuário', () => {
  expect(esc('<img onerror=x>')).toBe('&lt;img onerror=x&gt;');
  expect(card('Supino <b>', 'x')).toContain('Supino &lt;b&gt;');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/dashboard-layout.test.ts`
Expected: FAIL — módulo não existe.

- [ ] **Step 3: Write minimal implementation**

`src/dashboard/layout.ts` com: `esc`, `card`, `stat`, `page`. O CSS vai inline no `<style>` (sem arquivo estático
para servir), define os seis tokens em `:root`, inverte sob `@media (prefers-color-scheme: dark)`, usa coluna única
com 16 px de gutter, `font-variant-numeric: tabular-nums` nos números e a faixa inferior de navegação com
`aria-current="page"` na ativa, marcada por sublinhado preenchido (não só cor). As fontes IBM Plex entram como
`font-family` com fallback de sistema; os dois `woff2` são opcionais e ficam para um commit posterior, porque a
página tem de funcionar sem eles.

Os rótulos de navegação e os títulos de tela vão para `t.dashboard` em `src/i18n/pt-br.ts`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/dashboard-layout.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/layout.ts src/i18n/pt-br.ts tests/unit/dashboard-layout.test.ts
git commit -m "feat(dashboard): HTML shell, color tokens and bottom nav"
```

---

### Task 7: Cache com invalidação por escrita

**Files:**
- Create: `src/dashboard/cache.ts`
- Test: `tests/unit/dashboard-cache.test.ts` (criar)

**Interfaces:**
- Consumes: `Db`.
- Produces: `createPageCache(db: Db): { get(key: string, build: () => Promise<string>): Promise<string>; stamp(): string }`

A chave de invalidação é `max(audit_log.id)` + `max(health_daily.updated_at)`. O segundo termo é obrigatório:
`ingest/process.ts` grava os dados do relógio **sem passar pelo `audit_log`**.

- [ ] **Step 1: Write the failing test**

```ts
it('reaproveita o HTML até alguma escrita acontecer', async () => {
  const db = emptyDb();
  const cache = createPageCache(db);
  let builds = 0;
  const build = async () => `html ${++builds}`;

  expect(await cache.get('/peso?p=30d', build)).toBe('html 1');
  expect(await cache.get('/peso?p=30d', build)).toBe('html 1'); // veio do cache
  expect(builds).toBe(1);

  db.prepare(
    "INSERT INTO audit_log (entity, entity_id, action, created_at) VALUES ('meal', 1, 'create', '2026-10-17T12:00:00Z')",
  ).run();
  expect(await cache.get('/peso?p=30d', build)).toBe('html 2');
});

it('escrita do relógio também invalida (não passa por audit_log)', async () => {
  const db = emptyDb();
  const cache = createPageCache(db);
  let builds = 0;
  const build = async () => `html ${++builds}`;
  await cache.get('/sono?p=7d', build);

  db.prepare(
    "INSERT INTO health_daily (local_date, steps, updated_at) VALUES ('2026-10-17', 1513, '2026-10-17T19:00:00Z')",
  ).run();
  expect(await cache.get('/sono?p=7d', build)).toBe('html 2');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/dashboard-cache.test.ts`
Expected: FAIL — módulo não existe.

- [ ] **Step 3: Write minimal implementation**

```ts
import type { Db } from '../db/index.ts';

/** Memo de HTML por rota+período, descartado quando o banco muda. */
export function createPageCache(db: Db) {
  const entries = new Map<string, { stamp: string; html: string }>();
  const stampSt = db.prepare(
    `SELECT (SELECT COALESCE(max(id), 0) FROM audit_log) AS a,
            (SELECT COALESCE(max(updated_at), '') FROM health_daily) AS h`,
  );
  const stamp = () => {
    const r = stampSt.get() as { a: number; h: string };
    return `${r.a}|${r.h}`;
  };
  return {
    stamp,
    async get(key: string, build: () => Promise<string>): Promise<string> {
      const now = stamp();
      const hit = entries.get(key);
      if (hit && hit.stamp === now) return hit.html;
      const html = await build();
      entries.set(key, { stamp: now, html });
      return html;
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/dashboard-cache.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/cache.ts tests/unit/dashboard-cache.test.ts
git commit -m "feat(dashboard): page cache invalidated by audit log and health writes"
```

---

### Task 8: As seis páginas

**Files:**
- Create: `src/dashboard/pages.ts`
- Test: `tests/unit/dashboard-pages.test.ts` (criar)

**Interfaces:**
- Consumes: `page`, `card`, `stat`, `esc` (Task 6); `renderChartSvg` (Task 2); `kcalProteinSpec`, `stepsSpec`, `sleepSpec`, `weightTrendSpec`, `setsByMuscleSpec`, `e1rmSpec` (Task 3 e existentes); `buildReportBrief(..., { persist: false })` (Task 4); `trainedExercises`, `exerciseSessions` (Task 5 e existente); `epley` de `domain/training`.
- Produces, todas assíncronas e puras (recebem `db` só para ler):
  - `resumoPage(db, ctx): Promise<string>`
  - `pesoPage(db, ctx)`, `nutricaoPage(db, ctx)`, `treinoPage(db, ctx)`, `sonoPage(db, ctx)`
  - `exercicioPage(db, ctx, exerciseId?: number)`
  - `type PageCtx = { period: PeriodKey; range: { start: string; end: string }; now: string }`

Cada métrica degrada sozinha: sem dado, o cartão mostra o texto de "o que ligar" (`t.dashboard.semDadosSaude`), não
um gráfico vazio; com poucos pontos, mostra os pontos e quantos dias faltam (`days_with_data` / `nights` já vêm das
métricas).

- [ ] **Step 1: Write the failing test**

```ts
it('resumo traz os números do brief, sem inventar', async () => {
  const db = seededDb();
  const ctx = { period: '30d' as const, range: { start: '2026-09-18', end: '2026-10-17' }, now: NOW };
  const brief = buildReportBrief(db, 'adhoc', ctx.range, ctx.now, { persist: false });
  const html = await resumoPage(db, ctx);
  expect(html).toContain(String(brief.training.sessions));
  expect(html).toContain('kcal');
});

it('sono sem dados do relógio diz o que ligar, em vez de gráfico vazio', async () => {
  const db = seededDb(); // sem health_daily
  const html = await sonoPage(db, { period: '7d', range: { start: '2026-10-11', end: '2026-10-17' }, now: NOW });
  expect(html).toContain(t.dashboard.semDadosSaude);
  expect(html).not.toContain('<svg'); // nada de gráfico em branco
});

it('exercício sem id mostra o seletor e nenhuma série', async () => {
  const db = seededDb();
  const html = await exercicioPage(db, CTX);
  expect(html).toContain('<select name="id"');
  expect(html).toContain('<form method="get"');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/dashboard-pages.test.ts`
Expected: FAIL — módulo não existe.

- [ ] **Step 3: Write minimal implementation**

Uma função por tela, no mesmo molde. Exemplo de `sonoPage`, que mostra a degradação por métrica:

```ts
export async function sonoPage(db: Db, ctx: PageCtx): Promise<string> {
  const days = healthDays(db, ctx.range.start, ctx.range.end); // repo de saúde, já existe
  const steps = stepsStats(days, getGoals(db).steps);
  const sleep = sleepStats(days, getGoals(db).sleep_h);
  const blocks: string[] = [];

  if (steps.days_with_data === 0 && sleep.nights === 0) {
    blocks.push(card(t.dashboard.sono, `<p class="vazio">${esc(t.dashboard.semDadosSaude)}</p>`));
  } else {
    if (sleep.nights > 0) {
      blocks.push(card(t.dashboard.sono, await renderChartSvg(sleepSpec(sleepRows(days), getGoals(db).sleep_h))));
    } else {
      blocks.push(card(t.dashboard.sono, `<p class="vazio">${esc(t.dashboard.semSono)}</p>`));
    }
    if (steps.days_with_data > 0) {
      blocks.push(
        stat(t.dashboard.passosMedia, String(steps.steps_avg)),
        card(t.dashboard.passos, await renderChartSvg(stepsSpec(stepRows(days), getGoals(db).steps))),
      );
    }
  }
  return page({ title: t.dashboard.sono, active: 'sono', period: ctx.period, body: blocks.join('\n') });
}
```

As outras cinco seguem o mesmo padrão, com o conteúdo da tabela de telas da spec: `pesoPage` usa
`weightTrendSpec` + taxa semanal + manutenção; `nutricaoPage` usa `kcalProteinSpec` + médias + dias registrados;
`treinoPage` usa `setsByMuscleSpec` + tonelagem + PRs + parados; `exercicioPage` usa `trainedExercises` no
`<select>`, `exerciseSessions` filtrado pelo período e `e1rmSpec` com `epley`; `resumoPage` junta os destaques e
linka as outras.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/dashboard-pages.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/pages.ts src/i18n/pt-br.ts tests/unit/dashboard-pages.test.ts
git commit -m "feat(dashboard): six read-only pages with per-metric degradation"
```

---

### Task 9: Rotas, servidor e ligação no app

**Files:**
- Create: `src/dashboard/http.ts`
- Modify: `src/app.ts`
- Test: `tests/integration/dashboard.test.ts` (criar)

**Interfaces:**
- Consumes: tudo das tarefas anteriores.
- Produces:
  - `createDashboardApp(deps: { db: Db; settings: Pick<ToolSettings, 'cutoffHour' | 'timeZone'>; logger: Logger; clock?: () => string }): Hono`
  - `startDashboardServer(app: Hono, port: number): Promise<{ url: string; port: number; close: () => Promise<void> }>`
  - `parsePeriod(p: string | undefined, today: string): { key: PeriodKey; start: string; end: string }`

- [ ] **Step 1: Write the failing test**

```ts
it('serve as seis rotas e nenhuma escreve no banco', async () => {
  const db = seededDb();
  const app = createDashboardApp({ db, settings: SETTINGS, logger: silentLogger });
  const before = db.prepare('SELECT COALESCE(max(id),0) FROM audit_log').pluck().get();
  const settingsBefore = db.prepare('SELECT count(*) FROM settings').pluck().get();

  for (const path of ['/', '/peso', '/nutricao', '/treino', '/exercicio', '/sono']) {
    const res = await app.request(`${path}?p=30d`);
    expect(res.status, path).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('<html lang="pt-BR">');
  }

  expect(db.prepare('SELECT COALESCE(max(id),0) FROM audit_log').pluck().get()).toBe(before);
  expect(db.prepare('SELECT count(*) FROM settings').pluck().get()).toBe(settingsBefore);
});

it('período inválido cai no padrão de 30 dias', () => {
  expect(parsePeriod('bobagem', '2026-10-17').key).toBe('30d');
  expect(parsePeriod('7d', '2026-10-17')).toMatchObject({ start: '2026-10-11', end: '2026-10-17' });
});

it('rota desconhecida dá 404 e nenhuma rota aceita POST', async () => {
  const app = createDashboardApp({ db: seededDb(), settings: SETTINGS, logger: silentLogger });
  expect((await app.request('/nada')).status).toBe(404);
  expect((await app.request('/peso', { method: 'POST' })).status).toBe(404);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integration/dashboard.test.ts`
Expected: FAIL — módulo não existe.

- [ ] **Step 3: Write minimal implementation**

`src/dashboard/http.ts`: `parsePeriod` (mapeia `7d|30d|90d|ano` para dias via `addLocalDays`, com fallback `30d`),
um `app.get` por tela passando pelo cache (`createPageCache`), `c.html(...)`, e `startDashboardServer` com
`hostname: '127.0.0.1'`, no mesmo molde de `startIngestServer`.

Em `src/app.ts`, depois do ingest:

```ts
  const dashboard = config.DASHBOARD
    ? await startDashboardServer(
        createDashboardApp({ db, settings, logger: logger.child({ mod: 'dashboard' }) }),
        config.DASHBOARD_PORT,
      )
    : undefined;
```

incluir `dashboard: dashboard?.url` no `logger.info` de "impetus iniciado" e `await dashboard?.close()` no `stop()`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run check`
Expected: PASS (todos os 218 testes anteriores mais os novos)

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/http.ts src/app.ts tests/integration/dashboard.test.ts
git commit -m "feat(dashboard): routes, loopback server and app wiring behind DASHBOARD"
```

---

### Task 10: Documentação e exposição na VM

**Files:**
- Modify: `docs/DEPLOY.md` (§6, onde está o `tailscale serve` do ingest)
- Modify: `CHANGELOG.md`
- Modify: `docs/TASKS.md` (marcar o item de dashboard da Fase 7)

**Interfaces:**
- Consumes: `DASHBOARD`, `DASHBOARD_PORT` (Task 1).
- Produces: nada de código.

- [ ] **Step 1: Documentar**

Em DEPLOY.md §6, ao lado do comando do ingest, o do dashboard (o ingest já ocupa `/ingest/health`; o dashboard fica
na raiz do mesmo host da tailnet):

```bash
sudo tailscale serve --bg --set-path / http://127.0.0.1:8789
```

E a nota: ligar `DASHBOARD=true` em `/etc/impetus/env.app`, reiniciar o serviço, abrir
`https://impetus.<tailnet>.ts.net/` no celular com o Tailscale conectado.

- [ ] **Step 2: Atualizar CHANGELOG e TASKS**

Entrada no CHANGELOG com as telas, a flag, a decisão de zero JS e o achado da escrita no `buildReportBrief`.
Em `docs/TASKS.md`, marcar `- [x] Dashboard web somente leitura, servido via Tailscale`.

- [ ] **Step 3: Verificar**

Run: `npm run check`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add docs/DEPLOY.md CHANGELOG.md docs/TASKS.md
git commit -m "docs: dashboard setup on the VM and phase 7 item"
```

- [ ] **Step 5: Ligar na VM** (manual, com o dono)

Na VM: `DASHBOARD=true` em `/etc/impetus/env.app`, `git pull`, `npm run build`, `systemctl restart impetus`,
o `tailscale serve` acima, e abrir no celular.

---

## Self-review

**Cobertura da spec:** problema e telas → Task 8 e 9; decisões (zero JS, tailnet, flag, `persist:false`) → 1, 4, 9;
módulos novos → 6, 7, 8, 9; arquivos existentes que mudam → 1 (config, env.example), 2 (render), 3 (specs),
4 (build), 5 (repo), 6 (i18n), 9 (app), 10 (DEPLOY); dados e `buildChartData` não reutilizado → 8; gráficos e
tokenização → 2 e 3; cache e invalidação dupla → 7; degradação por métrica → 8; acesso loopback → 9 e 10; design
visual → 3 e 6; testes da spec → todos os passos de teste, com o de "nenhuma escrita" em 9.

**Lacuna aceita:** os dois `woff2` da IBM Plex ficam para depois do piso funcionar, porque a página tem de ser
legível sem eles (Task 6 usa fallback de sistema). A spec os descreve como parte da identidade; se forem ficar de
fora de vez, a spec precisa ser corrigida, não o contrário.

**Consistência de tipos:** `PeriodKey` e `Nav` nascem em Task 6 e são usados em 8 e 9; `PageCtx` nasce em 8 e é
consumido em 9; `renderChartSvg` nasce em 2 e é usado em 8; `createPageCache` nasce em 7 e é usado em 9;
`trainedExercises` nasce em 5 e é usado em 8. Sem nomes divergentes.
