# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/). Decisões em `docs/DECISIONS.md`.

## [Unreleased]

### Fase 5 — Relatórios e insights (2026-10-14)

#### Adicionado
- Scheduler ligado no app (croner, fuso `TZ`, `job_runs` com chave de período: não repete após reinício):
  relatórios diário/semanal/mensal, alertas `hc_stale` e token Claude, reprocesso de turnos, backup.
- `/relatorio [dia|semana|mes]` gera na hora; com `BRAIN_PROVIDER=none` ou falha do cérebro sai o fallback.
- Mensagens proativas respeitam `/pausar` (alertas críticos continuam); relatório agendado pausado é pulado.
- Testes: métricas por fixture, disparo/não disparo de cada detector, semana sintética → brief e snapshot do
  fallback, idempotência do scheduler.

#### Corrigido
- `wa:link`: espera e grava as credenciais antes de sair (no Windows `creds.json` ficava com 0 bytes) e
  explica o erro 401; navegador `Browsers.macOS('Chrome')` (nome customizado falhava no pareamento por código).

#### Adicionado (robustez)
- `wa:link` detecta sessão já vinculada (exige `--force`) ou incompleta (move para `.bak-*`) e confere o
  `creds.json` antes do ✅.
- Relatório agendado espera o canal conectar (até 30 min) antes de gerar; se não conectar, não gasta cota e o
  job `report.catchup` (de hora em hora) reenvia quando o canal volta.
- `/retomar` oferece os relatórios pulados durante a pausa.
- `/recarga` + job `alert.sim_recharge`: lembrete crítico a partir de 25 dias sem recarga do chip pré-pago.

#### Adicionado (5b)
- Gráficos dos relatórios (`REPORT_CHARTS`): semanal = tendência de peso de 8 semanas + séries por grupo
  muscular; mensal = e1RM dos principais exercícios. Vega-Lite → SVG (vega) → PNG 1080 px (resvg), tema
  escuro, números em pt-BR; enviados como imagem após o texto. Falha de gráfico não impede o relatório.
- Dependências fixadas: `vega@6.4.0`, `vega-lite@6.4.3`, `@resvg/resvg-js@2.6.2` (binário linux-arm64-gnu).

#### Pendente
- Evals de relatório contra o cérebro real.

### Canal Telegram (2026-10-14, D-026/D-027)

#### Adicionado
- Canal `telegram` (Bot API por long polling, sem dependência nova): texto, fotos, citação, reação 👀 e
  "digitando…", offset confirmado só após processar, erros sem o token. `TELEGRAM_BOT_TOKEN` obrigatório com
  `CHANNEL=telegram`.

#### Alterado
- `runtime/.env.example`: volta a `CHANNEL=whatsapp` (Baileys no chip secundário do dono); Telegram fica como alternativa. WhatsApp Cloud API avaliada e descartada (erro 130497).

#### Pendente (dono)
- Criar o bot no @BotFather, pôr o token no `.env` e parear com `PAREAR <código>`.

### Fase 4 — Saúde (Health Connect via HC Webhook) (2026-10-14)

#### Adicionado
- `POST /ingest/health` (Hono, 127.0.0.1): `X-Api-Key` com comparação em tempo constante, até 1 MB, 60 req/min,
  bruto em `health_raw` com dedupe por SHA-256, normalização numa fila interna; `GET /healthz`.
- Normalização (D-025): passos, sono com estágios, FC (amostra ou agregado), FC de repouso, HRV, calorias ativas e
  totais, distância, SpO₂, peso e % de gordura (`body_metrics`), exercícios (`cardio_sessions`); outros tipos ficam
  só no bruto.
- `health_daily` recalculado por dia afetado; tool `get_health_range`; `get_day_summary` com passos e sono.
- Alerta `hc_stale` (1 por ocorrência).
- `npm run hc:fixture`: exporta o último payload real anonimizado para `tests/fixtures/`.

#### Pendente (dono)
- Configurar o HC Webhook, capturar um payload real e rodar `npm run hc:fixture` para validar o mapeamento.

### Fase 3 — Nutrição (2026-10-14)

#### Adicionado
- Domínio: macros por item (tabela × gramas), soma e arredondamento, porção de rótulo → por 100 g, confiança
  agregada ponderada por kcal (D-021), priors pessoais (mediana/p25/p75, 120 dias, n ≥ 2), detector de viés
  (14 dias, > 60% das correções para baixo), tipo de refeição pelo horário.
- Tools: `search_foods` e `get_portions` em lote, `get_food_priors`, `log_meal`, `update_meal_item` (grava
  `meal_corrections`, item vira `corrected`), `add_meal_item`, `update_meal`, `create_custom_food`,
  `lookup_barcode` (Open Food Facts via etapa `prepare` assíncrona, D-022).
- Undo de refeições, itens, correções, alimentos e porções; `/hoje` completo.
- Contexto do turno: refeição citada com `item_id`, pergunta pendente e calibração de viés; `get_day_summary` com
  os itens de cada refeição (D-023).
- Evals: 12 casos em `evals/cases/meals_*.yaml` e `npm run eval` (cérebro real, banco novo por caso).

#### Verificado com o cérebro real
- 9/9 casos de texto passam (gramas informadas, unidades, medidas do IBGE, texto vago, gordura oculta, alimento
  personalizado, correção com e sem citação, refeição de ontem). 3 casos de foto aguardam imagens do dono.

#### Alterado
- `runtime/prompts/system.md`: unidades viram um item com o total (`text_estimate`); gordura de preparo
  obrigatória; buscas em lote; uso de `<quoted>`, `<pending_question>` e `<calibration>` (D-024).

### Fase 2 — WhatsApp (2026-10-14)

#### Adicionado
- Canal `whatsapp-baileys` (Baileys 7.0.0-rc14 fixado, D-020): reconexão com backoff (até 60 s), envio serial com
  intervalo mínimo, reação 👀 + "digitando…", download e normalização de imagens (sharp: 1568 px, JPEG q85, sem
  EXIF), id da mensagem citada, mensagens longas em até 3 partes.
- `npm run wa:link` (código de pareamento ou QR); sessão em `data/wa-auth/` (modo 700).
- Pareamento do dono (`PAREAR <código>`) e allowlist por JID + LID, com aprendizado de identificadores novos.
- Debounce (4 s; 20 s após imagem sem legenda) e fila serial de turnos.
- `/status`: canal, último turno, custo do dia, último backup, último sync de saúde, validade do token.
- `docs/MANUAL_TEST_WHATSAPP.md`: roteiro de aceite pelo celular.

#### Pendente (dono)
- Rodar o roteiro manual com o chip do bot.

### Fase 1 — Cérebro, tools de treino e canal terminal (2026-10-14)

#### Adicionado
- `tools/registry.ts`: envelope `{ok, data | error}`, escopo read/write (FORBIDDEN em turno de relatório), validação
  zod, transação por chamada (erro esperado desfaz as escritas) e `audit_log` com `turn_id`.
- Domínio de treino (funções puras): peso efetivo por tipo de carga, e1RM (Epley), PRs (carga, e1RM, reps na
  mesma carga), `vs_last`, progressão dupla (increase/hold/deload/first_time), estagnação, sessão aberta.
- Tools: `search_exercises` (com lote, D-019), `create_exercise`, `add_exercise_alias`, `define_routine`,
  `log_workout`, `get_last_sessions`, `get_next_targets`, `log_cardio`, `set_goal`, `get_goals`,
  `get_day_summary` (parcial).
- Servidor MCP streamable HTTP (sem estado) em 127.0.0.1, com token por turno (sha256 no banco, revogado ao fim).
- `ClaudeCliBrain`: flags do §5.1, prompt via stdin, cwd em `BRAIN_DIR`, `Read` só na mídia (D-015), config MCP
  em arquivo 600 (D-016), isolamento `--setting-sources ""` medido (D-018); `ContextBuilder` (§5.2) com sessão
  aberta detalhada; roteador de modelo (§5.3); `BRAIN_PROVIDER=none`.
- Turn-runner com retry que desfaz as escritas da tentativa falha (D-014), `deferred` no limite de uso.
- Undo por turno (`/desfazer` e retry) para séries, sessões, cardio, rotinas, exercícios, apelidos e metas.
- Comandos `/ajuda`, `/treino`, `/ultimo`, `/metas`, `/meta` (apelidos PT-BR, D-017), `/desfazer`.
- Canal `terminal` + `npm run chat` (`/img caminho legenda`, `/citar n texto`); `npm run dev` com o canal do `.env`.
- 110 testes, incluindo ponta a ponta do gateway com um "LLM falso" chamando as tools pelo MCP real.

#### Verificado com o cérebro real (haiku, assinatura Pro)
- Os 6 critérios de aceite da Fase 1 no `npm run chat`; 11–19 s por turno, 2–3 chamadas ao modelo, ~US$ 0,01
  estimado por turno.

#### Alterado
- `runtime/prompts/system.md`: busca de exercícios em lote (D-019).

### Fase 0 — Fundação (2026-10-13/14)

#### Adicionado
- Scaffold Node 24 + TypeScript 6 (ESM estrito, executado nativamente pelo Node; `tsc` só no build), ESLint 10
  (flat config), Prettier, Vitest. Scripts: `dev`, `build`, `check`, `db:migrate`, `db:seed`, `chat`, `eval`,
  `wa:link`, `logs:pretty` (`chat`, `eval` e `wa:link` são stubs até as Fases 1–3).
- `src/config.ts`: validação do ambiente com zod; erro lista todos os problemas sem ecoar valores; exige chave do
  provider escolhido e `INGEST_API_KEY` forte em produção; recusa `BRAIN_DIR` dentro do repositório.
- `src/time.ts`: `toLocalDate` com virada às 04:00 no fuso America/Sao_Paulo via base de fusos (testado com o
  horário de verão de 2018/2019), limites UTC do dia contábil, formatação pt-BR.
- `src/text/normalize.ts`: `normalize()` (minúsculas, sem acento, pontuação → espaço) e consultas FTS5 (palavras
  exatas, depois prefixos com corte de gênero/número).
- `src/logger.ts`: pino com redação de tokens, chaves e credenciais.
- Migration `001_init.sql` com todo o DATA_MODEL (com os ajustes D-005 a D-010), conexão com os PRAGMAs do spec.
- Repositórios `foods` (upsert, busca FTS, medidas) e `exercises` (upsert, apelidos, FTS, busca por apelido exato
  e FTS).
- Seeds versionados em `seeds/vendor/` com `manifest.json` (sha256, fonte, licença) e verificação obrigatória:
  - TACO 4ª ed.: 591 alimentos (6 sem energia na fonte oficial ficam de fora; ver D-013).
  - free-exercise-db: 876 exercícios, com músculos mapeados para o vocabulário fixo.
  - IBGE (POF 2008–2009): 84 medidas caseiras conferidas no PDF oficial, com página e referência.
- `scripts/provenance/`: scripts que conferiram a TACO e extraíram/conferiram as medidas do IBGE.
- 56 testes (unit + integração com banco em memória), incluindo 5 alimentos da TACO conferidos contra o PDF
  oficial e os aceites `search_foods("arroz cozido")` e `search_exercises("sup inc")`.
- `docs/DECISIONS.md`.
- `seeds/exercises_ptbr.csv`: 104 exercícios comuns com nome PT-BR, apelidos, tipo de carga, incremento e músculos
  (revisado e aprovado pelo dono).

#### Alterado
- Projeto renomeado de FitCoach para **Impetus** (D-001); kit movido para a raiz do repositório (D-002).
- Node 22 → 24, sem `tsx` (D-003); cwd do cérebro movido para `BRAIN_DIR`, fora do repositório (D-004).
- `docs/ARCHITECTURE.md`, `docs/DATA_MODEL.md`, `docs/DEPLOY.md`, `docs/TASKS.md`, `CLAUDE.md` e
  `runtime/.env.example` atualizados conforme as decisões.

#### Pendente
- Itens em aberto para as próximas fases listados em `docs/DECISIONS.md` (retry sem duplicar, `query_sql` em
  worker, chaves de meta, confiança agregada etc.).
