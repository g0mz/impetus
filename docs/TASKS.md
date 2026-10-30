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
│  ├─ prompts/checkin.md      (check-in diário; Fase 8d)
│  ├─ evidence/*.md           (base de evidências lida sob demanda; Fase 8e)
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
- [x] Dashboard web somente leitura, servido via Tailscale. *(2026-10-17, seis telas, zero JS)*
- [ ] Importação do CSV de outro app de treino (Strong ou Hevy) para histórico antigo.

## Fase 8 — Coach: tom, memória e iniciativa

Inspirada no my-fitness-claw (D-035). O Impetus continua dono dos dados (banco, tools, contas no código); esta fase dá ao coach tom, memória da pessoa e iniciativa. Subfases na ordem abaixo, cada uma fechando com `npm run check` e os evals afetados. DATA_MODEL, TOOLS e ARCHITECTURE são atualizados junto com cada subfase que mexe neles.

### 8a — Tom do coach (prompt + gateway)

- [x] Seção `# Tom` em `runtime/prompts/system.md`: número sempre com o que significa contra o próprio histórico; a pessoa antes do dado ("saí do plantão" → uma palavra sobre o plantão antes do número); deslize na dieta é normal, sem plano de compensação; pesagem isolada é ruído, aponte a tendência devolvida pela tool; problema pessoal (sono, estresse, motivação) → uma pergunta antes de aconselhar; elogio raro e específico; uma recomendação, não um menu; sem oferta de ajuda no fim.
- [x] ~12 trocas de exemplo em PT-BR (estilo, não frases para copiar). Os formatos de registro (✅, 🍽️, ✏️) continuam valendo: o tom entra numa linha a mais, nunca no lugar do formato.
- [x] Resposta só com reação: texto final igual a um emoji da allowlist (👍, 🔥, 👏; o Telegram só aceita uma lista fechada, sem 💪) vira reação à mensagem do usuário. `Channel.react?(m, emoji)`; o terminal imprime `[reação 👍]`; canal sem `react` envia o emoji como texto.
- [x] Asserções de texto no `scripts/eval.ts` (`reply_matches` / `reply_not_matches`), se ainda não existirem.
- [x] Evals: `coach_slip` (rodízio de pizza → registra, sem "compensar"), `coach_weight_noise` (+0,8 kg → fala da tendência), `coach_life_first` (peso + "saí do plantão" → registra e pergunta do plantão), `coach_thanks` ("valeu" → reação).

### 8b — Memória da pessoa

- [x] Tabela `coach_notes`: `id`, `kind` (`preference` | `observation` | `life_event`), `text` (≤ 200 caracteres), `due_local_date` (só `life_event`), `created_at`, `resolved_at`, `turn_id`, `deleted_at`.
- [x] Tools `remember_note` (`kind`, `text`, `due_date?`, `replaces_id?` para nota que contradiz outra), `resolve_note` (`note_id`, `outcome?` → vira observation) e `forget_note`, via registry com `audit_log`.
- [x] `ContextBuilder`: bloco `<coach_notes>` com ids: todas as preferências, observações mais recentes e `life_event` vencido ou vencendo em ≤ 2 dias. Orçamento ~1.500 caracteres dentro do de §5.2; corta primeiro observações antigas (função pura, com teste).
- [x] Prompt: o que vira cada tipo; preferência pedida vence observação; dor ou lesão relatada vira `life_event` com data para perguntar de novo; `life_event` vencido é perguntado uma vez e depois resolvido.
- [x] Comandos `/notas` (lista com ids) e `/esquecer <id>` (soft delete), sem LLM.
- [x] Limpeza no job semanal, em código: `life_event` resolvido há > 30 dias e observação sem uso há 90 dias → soft delete.
- [x] Evals multi-turno: `coach_memory_preference` ("para de usar emoji" → turno seguinte sem emoji) e `coach_memory_life` (viagem até sexta → turno de sábado pergunta da viagem).

### 8c — Agenda semanal e ajustes temporários

Pré-requisito do check-in: hoje as rotinas não têm dia da semana.

- [x] Tabela `routine_schedule` (`weekday` 0–6, `routine_id`) e tool `set_weekly_schedule` ("upper A seg e qui, lower A ter e sex").
- [x] Tabela `plan_overrides`: `id`, `from_local_date`, `until_local_date`, `text`, `weekday_changes` (JSON opcional; `null` = folga), `turn_id`, `deleted_at`. Muda sessões, **nunca metas**.
- [x] Tools `set_plan_override` / `end_plan_override` / `get_week_plan`. `domain/training/schedule.ts` (puro, com testes) resolve a sessão planejada de um dia com overrides; `get_next_targets` e `get_day_summary` devolvem `planned_today`.
- [x] Contexto: `<plan_overrides>` ativos, curto. Override vencido some pelo filtro de data, sem job.

### 8d — Check-in diário

- [x] Job `checkin` (`CHECKIN_CRON`, padrão 07:30; `CHECKIN_ENABLED`; respeita `/pausar`), dedupe por dia em `job_runs`.
- [x] `reports/checkin.ts` monta um brief determinístico: sessão planejada (com override), alvos, sono da noite, `life_event` vencendo hoje, dado faltando de ontem. Sem sessão, sem sono ruim e sem nota vencendo → **não envia nada** e não chama o cérebro.
- [x] Turno `mode: 'checkin'`, `toolScope: 'read'`, `runtime/prompts/checkin.md`: 1 a 3 linhas; sono < 6 h → manter cargas e cortar a última série se pesar.
- [x] Fallback sem LLM ("Hoje: <rotina> · <exercício> <alvo>…") com snapshot test.
- [x] Pendência do relatório de domingo 20:00: mantido (D-036).

### 8e — Base de evidências

- [x] `runtime/evidence/*.md` em PT-BR: volume, intensidade e esforço, frequência, descanso, proteína (com timing), balanço energético (com carboidrato e gordura), suplementos e `mitos.md`.
- [ ] Progressão, deload, seleção de exercícios e adesão: sem fonte conferida ainda (D-037). Formato: conclusão, força da evidência (forte | moderada | fraca), padrão, ressalvas, fontes com DOI.
- [x] Regra 10: cada DOI conferido no Crossref ou OpenAlex e cada número no abstract ou texto completo; afirmação sem fonte conferida não entra. Commitado por pedido do dono; **revisão do dono pendente** (D-037).
- [x] O cérebro lê sob demanda com `Read` (`--add-dir runtime/evidence`; atualizar ARCHITECTURE §5.1) e um índice de uma linha por arquivo no `system.md`. A evidência fica nos bastidores: nada de "estudos mostram", salvo se perguntarem por quê.
- [x] Evals: `evidence_myth_breakfast`, `evidence_creatine`, `evidence_rest_interval` (resposta curta, sem citar autor, coerente com o arquivo).

### 8f — Simulação por personas (sob demanda)

- [x] `now` injetável no turn-runner e no `ContextBuilder` (relógio simulado).
- [x] `evals/personas/*.md`: semana típica do dono; semana com viagem e dor; sumiço de 5 dias e volta.
- [x] `scripts/simulate.ts` (`npm run simulate`): um modelo faz a persona pelo canal terminal, com banco temporário e relógio avançando entre momentos (inclui check-ins); no fim, turnos com falha e rubrica de tom (critérios da 8a) avaliada por LLM-juiz; transcrição em `data/logs/simulate/`. Consome cota: só quando pedido.

**Aceite:** "pesei 74,8" um dia depois de 74,0 responde com a tendência, sem alarme; "viajo até sexta, só academia de hotel" cria um override e o check-in de quarta reflete isso, e o de sábado volta ao normal; em dia de descanso sem novidade o check-in não envia nada; "para de usar emoji" vale nos turnos seguintes e aparece em `/notas`; "café da manhã é obrigatório?" responde em até 2 linhas, coerente com `mitos.md`; evals 8a–8e verdes.

## Fase 9 — Cofre Obsidian (segundo cérebro)

Spec: `docs/superpowers/specs/2026-10-30-vault-second-brain-design.md` (rascunho, aguarda revisão do dono).

- [ ] 9a — MVP: log diário Telegram → `Diario/Log/` com links automáticos (`src/vault/`).
- [ ] 9b — Cofre → bot: tools `vault_search` e `vault_read` (somente leitura).
- [ ] 9c — Banco → cofre: notas geradas de treino e nutrição.
- [ ] 9d — Revisão semanal e sugestão de links por LLM.
