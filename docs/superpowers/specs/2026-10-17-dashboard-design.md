# Dashboard de visualização — design

**Data:** 2026-10-17 · **Fase:** 7 (opcional) · **Estado:** aprovado, revisado duas vezes

## Problema

Os dados do Impetus só são visíveis em texto no WhatsApp: `/hoje`, `/treino`, `/ultimo` e o relatório semanal. Isso
atende a olhada rápida e a consulta de carga na academia, mas não atende **explorar histórico**: escolher período,
comparar meses, ver a evolução de uma carga específica. Essa é a lacuna que este dashboard preenche.

Um usuário (o dono), celular como tela principal, leitura ocasional. Nenhuma escrita pela web.

## Decisões

| Decisão | Alternativas descartadas |
|---|---|
| HTML renderizado no servidor, gráficos SVG, **zero JavaScript** | API JSON + Vega-Lite no cliente (~500 KB de JS, contrato a manter, ganha tooltip/zoom); SPA com framework (peso morto para um usuário) |
| Alcance pela **tailnet** com `tailscale serve`; app escuta só em `127.0.0.1:8789` | HTTPS público com senha (expõe à internet por nada); só imagens pelo WhatsApp (sem interação) |
| Troca de recorte por querystring e `<form method=get>` | Controles em JS |
| Atrás da flag `DASHBOARD=false` por padrão | Sempre ligado |
| `buildReportBrief` ganha `{ persist: false }` para o dashboard | Chamar com `kind='daily'` só para evitar a escrita (gambiarra que muda o conteúdo do brief) |

A escolha de SVG inline (em vez do PNG do pipeline de relatórios) tem uma consequência desejada: os gráficos herdam
as variáveis CSS da página, então o modo escuro os reestiliza sem re-renderizar no servidor. Isso **exige** o passo
de tokenização descrito em "Gráficos".

## Telas

Seis rotas `GET`, todas aceitando `?p=7d|30d|90d|ano` (padrão `30d`):

| Rota | Conteúdo |
|---|---|
| `/` | Resumo: peso e tendência, média de kcal e proteína contra as metas, séries da semana, passos, sono |
| `/peso` | Peso com média móvel, taxa semanal, estimativa de manutenção |
| `/nutricao` | Kcal e proteína por dia contra as metas, médias, dias registrados |
| `/treino` | Séries por grupo muscular, tonelagem, PRs do período, exercícios parados |
| `/exercicio?id=N` | Carga, e1RM e repetições de um exercício ao longo do tempo; `<select>` com os treinados no período |
| `/sono` | Horas por noite, passos por dia, FC de repouso, correlação sono × desempenho |

## Arquitetura

```
channels/whatsapp ─┐
                   ├─► (já existe) gateway, tools, domain, db
ingest/http :8787 ─┤
dashboard/http :8789 ──► dashboard/pages ──► domain/metrics/*  ──► db (somente leitura)
  (hono, loopback)        (dados → HTML)      reports/build (buildReportBrief, persist:false)
                          dashboard/layout    charts/specs + renderChartSvg
```

### Módulos novos

| Módulo | Responsabilidade |
|---|---|
| `src/dashboard/http.ts` | App hono e rotas, no formato de `ingest/http.ts`; `hostname: '127.0.0.1'` |
| `src/dashboard/pages.ts` | Uma função pura por tela: dados → HTML. Sem SQL, sem I/O |
| `src/dashboard/layout.ts` | Casca HTML, tokens CSS, navegação inferior |
| `src/dashboard/cache.ts` | Memo por `rota+período`, invalidado por escrita (ver abaixo) |

### Arquivos existentes que mudam

A primeira versão desta spec dizia que "nada fora de `dashboard/` muda". Era falso. A lista real:

| Arquivo | Mudança |
|---|---|
| `src/reports/build.ts` | `buildReportBrief` ganha `opts: { persist?: boolean }`. **Hoje ele escreve**: a linha `if (kind !== 'daily' && …) setSetting(db, 'metrics.maintenance_estimate', …)` gravaria a cada carregamento de página. Com `persist: false` a escrita é pulada; o padrão segue `true`, então os relatórios não mudam |
| `src/charts/render.ts` | Extrai `renderChartSvg(spec): Promise<string>` do meio do `renderChart`, que já gera SVG por dentro (`view.toSVG()`) antes de rasterizar; `renderChart` passa a chamá-lo. Sem duplicação |
| `src/charts/specs.ts` | Ganha `kcalProteinSpec`, `stepsSpec`, `sleepSpec` e os tokens de cor compartilhados |
| `src/db/repos/training.ts` | Ganha a consulta de séries de um exercício num período e a lista de exercícios treinados |
| `src/config.ts` | `DASHBOARD` (bool, padrão false) e `DASHBOARD_PORT` (padrão 8789) |
| `src/main.ts` | Sobe o servidor do dashboard quando a flag está ligada, e o encerra no shutdown junto dos outros |
| `src/i18n/pt-br.ts` | Todo texto de interface |
| `runtime/.env.example`, `docs/DEPLOY.md` | As duas variáveis e o `tailscale serve` da nova rota |

O domínio continua sem I/O de rede, e nenhuma rota escreve no banco.

### Dados

As páginas chamam `buildReportBrief(db, kind, period, now, { persist: false })`, que aceita período arbitrário, e os
módulos de `domain/metrics/*`. `kind` vale `'adhoc'`: `periodLabel` cai no rótulo de intervalo (`13–17/out`), que é
o certo para recorte livre.

**`buildChartData` não é reutilizado**: ele tem ramos condicionados a `kind === 'weekly'` e `=== 'monthly'`,
pensados para o relatório, e devolveria gráficos vazios em `adhoc`. O dashboard monta os próprios dados de gráfico.

### Gráficos

`renderChartSvg` devolve o SVG do Vega. Para o modo escuro funcionar sem re-renderizar, as cores **não** podem ficar
cravadas como hex no SVG: os specs recebem os tokens e um passo de tokenização troca cada hex conhecido por
`var(--token)` dentro dos atributos `style`, que é onde `var()` resolve (atributo de apresentação `fill="var(…)"`
não resolve — por isso o passo existe e tem teste). Hex desconhecido no SVG é erro de teste, para não escapar cor
fora do sistema.

### Cache e invalidação

`buildReportBrief` carrega 120 dias de séries mais o histórico de peso a cada chamada, e renderizar Vega custa CPU
numa VM de 1 GB. Um `Map` em memória guarda o HTML por `rota+período`.

A chave de invalidação é o par **`max(audit_log.id)` + `max(health_daily.updated_at)`**. O segundo termo é
obrigatório: `ingest/process.ts` grava `health_samples` e `health_daily` **sem passar pelo `audit_log`**, então
sozinho o primeiro termo deixaria os dados do relógio velhos na tela até a próxima refeição registrada.

`?p=ano` é o recorte mais caro (o brief carrega 365 + 120 dias de séries). Com cache, custa uma vez por escrita.
Se na VM passar de ~3 s, a saída é limitar o período das séries, não tirar a tela.

### Degradação por métrica

Hoje `health_daily` tem passos nos últimos quatro dias, mas `sleep_minutes` e `resting_hr` estão **nulos** (os tipos
provavelmente não estão habilitados no app HC Webhook). Cada métrica se degrada sozinha, nunca a tela inteira:

- sem nenhum dado → texto que diz o que ligar e onde (DEPLOY.md §6), não gráfico em branco;
- com poucos pontos → mostra os pontos e diz quantos dias faltam para a tendência ter sentido (os módulos de
  métrica já devolvem `days_with_data` / `nights`).

### Acesso

Somente leitura: nenhuma rota `POST`, nenhuma tool, nenhuma escrita. A tailnet é a autenticação — sem senha nova
para vazar. `DASHBOARD_PORT=8789` em loopback; o `tailscale serve` da VM atravessa, como já faz com o ingest, em
caminho próprio (o ingest ocupa `/ingest/health`; o dashboard fica na raiz).

## Design visual

Direção: **registro de medição**. Um caderno de treino é instrumentação, não marketing: números alinhados, unidades
explícitas, metas marcadas. (A primeira proposta era "fundo escuro com um acento vivo" — reflexo genérico, trocado.)

**Cor**, semântica e nunca decorativa: `--papel #FBFAF7` · `--tinta #16181B` · `--dado #1F3A5F` (série principal)
· `--meta #C3D1B4` (faixa de alvo, dessaturada para ficar atrás do dado) · `--fora #B4532A` (só quando o valor sai
da faixa) · `--fraca #8A8F98` (eixos e rótulos). Invertida no escuro via `prefers-color-scheme`.

**Tipografia:** uma família em três papéis — IBM Plex Mono nos números (tabular de nascença, alinha colunas de série
e carga, e é o vernáculo de medição), Plex Sans Condensed em títulos e rótulos, Plex Sans no corpo. Dois `woff2`
auto-hospedados, ~40 KB, funciona sem internet.

**Elemento-assinatura: a faixa de meta.** A mesma gramática em todos os gráficos e barras — uma faixa horizontal com
o alvo e o dado por cima. Toda tela responde "estou dentro?" antes de qualquer número ser lido, e a faixa vem das
metas em `settings`. É a única ousadia; o resto fica quieto de propósito.

**Layout:** coluna única, 16 px nas laterais, sem moldura de cartão (borda come largura em celular); hairlines e
espaço separam blocos. Navegação numa faixa inferior de cinco rótulos (o resumo é o título, que leva a `/`), no
alcance do polegar, com a atual marcada por sublinhado preenchido, não só por cor.

Piso de qualidade: responsivo até 320 px, foco de teclado visível, `prefers-reduced-motion` respeitado (não há
animação nesta versão), contraste AA.

## Testes

- Unit nos três specs novos: campos de encoding esperados e a faixa de meta presente quando há meta.
- Unit na tokenização: nenhum hex sobra no SVG e cada token virou `var(--…)` dentro de `style`.
- Unit na consulta de séries por exercício (banco em memória com séries conhecidas).
- **Nenhuma escrita:** carregar as seis rotas não muda `max(audit_log.id)` nem `settings`. É o teste que pega a
  regressão do `persist`.
- Integração com banco em memória: sobe o app, bate nas seis rotas, confere status 200, `Content-Type` HTML, a
  presença dos rótulos de cada tela e **os números na página iguais aos do brief** (como `reports/verify.ts` faz).
- Invalidação do cache: gravar via tool muda a página; gravar em `health_daily` direto muda a página.
- Degradação: banco sem dados de sono rende a mensagem de "o que ligar", não exceção nem gráfico vazio.

## Fora de escopo

Tooltip e zoom (trocar o recorte recarrega a página), exportar CSV, qualquer edição pela web, PWA com ícone na tela
inicial (20 linhas de manifest depois, se a vontade aparecer), telas de correlação além de sono × desempenho.
