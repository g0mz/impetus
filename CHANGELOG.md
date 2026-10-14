# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/). Decisões em `docs/DECISIONS.md`.

## [Unreleased]

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
