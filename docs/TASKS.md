# TASKS — Plano de implementação

Cada fase termina **utilizável e testada**. Não avance com testes falhando. Ao fim de cada fase: `npm run check` (typecheck, lint e testes) verde, CHANGELOG atualizado e resumo do que foi feito e do que ficou pendente.

## Estrutura alvo do repositório

```
impetus/
├─ CLAUDE.md
├─ package.json · tsconfig.json · tsconfig.build.json · vitest.config.ts · eslint.config.js · .gitignore
├─ docs/                      (este kit)
├─ runtime/
│  ├─ prompts/system.md       (system prompt do coach)
│  ├─ prompts/report.md       (instruções extras para turnos de relatório)
│  ├─ .env.example
│  └─ deploy/impetus.service
├─ seeds/
│  ├─ exercises_ptbr.csv      (~80 exercícios comuns, aliases, load_kind, increment_kg)
│  ├─ portions_ibge.csv       (medidas caseiras conferidas na fonte)
│  └─ vendor/                 (TACO e free-exercise-db versionados + manifest.json com sha256; D-013)
├─ scripts/
│  ├─ db-migrate.ts · db-seed.ts (lógica dos seeds em src/seeds/)
│  ├─ provenance/             (scripts Python que conferiram TACO e IBGE nos PDFs oficiais)
│  ├─ wa-link.ts              (vincular número do bot)
│  ├─ chat.ts                 (REPL no terminal usando o cérebro real)
│  ├─ eval.ts                 (roda evals/ contra o cérebro real)
│  └─ backup.sh
├─ evals/cases/*.yaml         (conversas de referência + asserções no banco)
├─ src/
│  ├─ main.ts                 (bootstrap: config, db, mcp, ingest, canal, scheduler)
│  ├─ cli.ts                  (erro de configuração vira mensagem limpa)
│  ├─ config.ts               (zod sobre process.env)
│  ├─ logger.ts
│  ├─ time.ts                 (fuso, local_date com cutoff)
│  ├─ text/normalize.ts       (normalize() e consultas FTS)
│  ├─ seeds/                  (TACO, exercícios, medidas IBGE, verificação do manifest)
│  ├─ db/ index.ts · migrate.ts · migrations/NNN_*.sql · repos/*.ts
│  ├─ domain/
│  │  ├─ training/ parse-helpers.ts · progression.ts · prs.ts · volume.ts
│  │  ├─ nutrition/ macros.ts · priors.ts · confidence.ts
│  │  ├─ health/ normalize-hc.ts · daily.ts
│  │  ├─ metrics/*.ts         (REPORTS.md §2)
│  │  └─ insights/*.ts        (REPORTS.md §3)
│  ├─ tools/ registry.ts · training.ts · nutrition.ts · body.ts · analysis.ts · sql-guard.ts
│  ├─ mcp/server.ts           (streamable HTTP, auth por token de turno)
│  ├─ brain/ types.ts · claude-cli.ts · context-builder.ts · router.ts · (anthropic-api.ts) · (gemini.ts)
│  ├─ channels/ types.ts · terminal.ts · whatsapp-baileys.ts · (telegram.ts)
│  ├─ gateway/ inbox.ts · debounce.ts · queue.ts · commands/*.ts · turn-runner.ts · owner-pairing.ts
│  ├─ ingest/ http.ts
│  ├─ media/ images.ts
│  ├─ reports/ build.ts · render-fallback.ts · charts.ts
│  └─ scheduler/ jobs.ts
├─ tests/ unit/ · integration/ · fixtures/
└─ data/                      (gitignored: impetus.db, media/, wa-auth/, backups/; o cwd do cérebro fica em BRAIN_DIR, fora do repo)
```

---

## Fase 0 — Fundação

- [x] Scaffold Node 24 + TS (ESM), eslint, prettier, vitest, scripts npm: `dev`, `build`, `check`, `db:migrate`, `db:seed`, `chat`, `eval`, `wa:link`, `logs:pretty` (os dois últimos podem ser stubs até a Fase 2).
- [x] `config.ts` com zod; falha clara se faltar variável.
- [x] `time.ts`: `toLocalDate(utc, cutoffHour)`, formatação pt-BR, testes cobrindo virada à meia-noite, 04:00 e horário de verão (o Brasil não tem DST desde 2019, mas não codifique esse pressuposto; use a base de fusos).
- [x] DB: conexão, PRAGMAs, migrations de **todo** o DATA_MODEL.md.
- [x] Seeds:
  - TACO: importer com validação (contagem e 5 alimentos conferidos contra a tabela oficial, registrados no teste).
  - free-exercise-db: download via script, mapeamento de músculos para o vocabulário fixo.
  - `seeds/exercises_ptbr.csv`: gerar uma proposta com ~80 exercícios comuns de academia brasileira e **pausar para revisão do usuário** antes de commitar.
  - `seeds/portions_ibge.csv`: só valores conferidos na fonte IBGE, com coluna `fonte_pagina`. Valor não confirmado não entra.
- [x] FTS de alimentos e exercícios; função `normalize()` (minúsculas, sem acento, espaços).

**Aceite:** `npm run db:migrate && npm run db:seed` num banco vazio; `search_foods("arroz cozido")` e `search_exercises("sup inc")` (direto pelos repos) retornam resultados corretos; `npm run check` verde.

## Fase 1 — Cérebro + tools de treino + canal terminal

- [x] `tools/registry.ts` com envelope, escopo, auditoria e `message_links`.
- [x] Tools de treino (TOOLS.md) + `get_goals`/`set_goal` + `get_day_summary` (parcial).
- [x] Domínio: e1RM, PRs, `vs_last`, progressão (REPORTS.md §2.4), sessão aberta.
- [x] `mcp/server.ts`: streamable HTTP em 127.0.0.1, tokens de turno (criados e invalidados pelo turn-runner), logs por tool call.
- [x] `brain/claude-cli.ts`: spawn exatamente como ARCHITECTURE.md §5.1, cwd `BRAIN_DIR` fora do repo (D-004), timeout, parse do JSON, captura de stderr, retry.
- [x] `context-builder.ts` (§5.2) e `router.ts` (§5.3).
- [x] `channels/terminal.ts` + `scripts/chat.ts`: REPL que simula o canal (aceita `/img caminho.jpg legenda`).
- [x] Turn-runner com tabela `turns`.
- [x] Comandos `/ajuda`, `/treino`, `/ultimo`, `/metas`, `/meta`, `/desfazer`.

**Aceite (no `npm run chat`):**
1. "meu upper B é: supino inclinado halter 3x8-12, remada curvada 4x6-10, elevação lateral 3x12-15" cria a rotina.
2. "upper B: supino inclinado halter 3x10 30kg, remada curvada 4x8 60kg, elevação lateral 3x15 10kg" registra 10 séries com os exercícios certos.
3. `/treino upper B` mostra cargas e alvos.
4. "supino 32kg 10 9 8", em seguida, anexa à sessão aberta.
5. `/desfazer` remove só o último turno.
6. Testes de integração das tools verdes, com banco temporário.

## Fase 2 — WhatsApp

- [x] `channels/whatsapp-baileys.ts`: conexão, reconexão com backoff, envio com intervalo mínimo, reação, presença, download de mídia, `stanzaId` da mensagem citada.
- [x] `scripts/wa-link.ts` (pairing code e QR).
- [x] Pareamento do dono (`PAREAR <código>`), allowlist com JID e LID.
- [x] Inbox idempotente, debounce (ARCHITECTURE.md §4.2), fila serial, 👀 + "digitando…".
- [x] `message_links` e correção por citação.
- [x] Imagens: sharp (lado maior 1568 px, JPEG q85, sem EXIF).
- [x] Mensagens grandes divididas em até 3 partes, respeitando quebras de linha.
- [x] `/status` (WhatsApp, último turno, custo estimado do dia, último backup, último sync de saúde).

**Aceite** (manual pelo celular: `docs/MANUAL_TEST_WHATSAPP.md`): do celular, os 5 cenários da Fase 1 funcionam via WhatsApp; mensagem de número não pareado é ignorada; foto seguida de texto em 10 s vira um turno só; reinício do serviço não perde mensagens nem exige novo vínculo.

## Fase 3 — Nutrição

- [x] Tools de nutrição (TOOLS.md), macros e confiança agregada no código.
- [x] Priors (mediana, p25 e p75 via `v_food_priors`) e calibração de viés (NUTRITION.md §5).
- [x] Open Food Facts (`lookup_barcode`), com timeout e User-Agent.
- [x] Tipo de refeição inferido pelo horário quando não informado (café < 10h30, almoço 10h30–15h, lanche 15h–18h30, jantar 18h30–22h30, ceia depois), sobrescrito pelo texto.
- [x] `/hoje` completo.
- [x] Evals: `evals/cases/meals_*.yaml` com ~12 casos (só texto, foto + legenda, foto sozinha, correção, rótulo). As asserções verificam estrutura (itens esperados presentes, item informado com as gramas exatas, origem correta) e faixas de tolerância nas estimativas. Use fotos próprias em `evals/images/` (fora do git se preferir).

**Aceite:** cenários do SPEC §7 de nutrição passam; item informado nunca é alterado pela foto; correção por citação atualiza o item e o total do dia; nenhuma refeição gera mais de uma pergunta.

## Fase 4 — Saúde (Health Connect)

- [x] `ingest/http.ts`: `POST /ingest/health` (X-Api-Key, rate limit, 1 MB máx.), `GET /healthz`.
- [x] `health_raw` com dedupe; normalização para `health_samples`; recálculo de `health_daily`; peso para `body_metrics`; exercícios para `cardio_sessions`.
- [ ] (dono) Capturar **um payload real** (`npm run hc:fixture` gera o fixture anonimizado) do HC Webhook, anonimizar e salvar como fixture; ajustar o mapeamento de estágios do sono a partir dele.
- [x] Alerta `hc_stale` (função pronta; disparo agendado na Fase 5).

**Aceite:** reenvio do mesmo payload não duplica nada; `get_day_summary` mostra passos e sono do relógio; sono que termina às 07:00 conta no dia contábil correto.

## Fase 5 — Relatórios e insights

- [x] Métricas (REPORTS.md §2) com testes por fixture: semana sintética com números conhecidos.
- [x] Detectores (§3) com testes de disparo e não disparo.
- [x] `reports/build.ts` → `ReportBrief` → turno de relatório (`toolScope='read'`, `runtime/prompts/report.md`) → envio.
- [x] Fallback determinístico com testes de snapshot.
- [x] Scheduler (croner, fuso) com `job_runs`; `/relatorio`, `/pausar`, `/retomar`.
- [x] **5b:** gráficos (Vega-Lite → PNG) atrás de `REPORT_CHARTS`.

**Aceite:** `/relatorio semana` com dados de fixture produz texto com números idênticos ao brief; com o cérebro desligado (`BRAIN_PROVIDER=none`), o fallback é enviado; jobs não disparam em duplicidade após reinício.

## Fase 6 — Deploy e operação

- [x] Build e teste na VM, linux-arm64 ou x86_64 (`better-sqlite3`, `sharp`, `@resvg/resvg-js`). *(E2.1.Micro x86_64, 2026-10-17)*
- [x] `deploy/setup-vm.sh` idempotente (DEPLOY.md §2–4) e unit do systemd. *(rodado na VM em 2026-10-17)*
- [x] Backup (`src/ops/backup.ts` + job) e **teste de restore documentado** (automatizado em `ops.test.ts`).
- [x] Alertas: token Claude expirando, backup falho, `hc_stale`, turnos falhos repetidos.
- [ ] Medição: RSS do processo após 24 h, latência p50/p90 por tipo de turno. *(241 MB em repouso na VM; falta a leitura após 24 h de uso)*

**Aceite:** VM reiniciada → serviço volta sozinho e o WhatsApp reconecta; restore completo em menos de 30 min seguindo o runbook; RSS < 400 MB.

## Fase 7 — Opcionais

- [x] Adaptador Telegram (plano B do canal).
- [ ] `AnthropicApiBrain` e/ou `GeminiBrain` reutilizando `tools/registry` (plano B da cobrança).
- [x] Transcrição de áudio (Whisper local `whisper.cpp` em ARM, modelo pequeno) para registrar treino por voz. *(D-030)*
- [ ] Dashboard web somente leitura, servido via Tailscale.
- [ ] Importação do CSV de outro app de treino (Strong ou Hevy) para histórico antigo.
