# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/). Decisões em `docs/DECISIONS.md`.

## [Unreleased]

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

#### Alterado
- Projeto renomeado de FitCoach para **Impetus** (D-001); kit movido para a raiz do repositório (D-002).
- Node 22 → 24, sem `tsx` (D-003); cwd do cérebro movido para `BRAIN_DIR`, fora do repositório (D-004).
- `docs/ARCHITECTURE.md`, `docs/DATA_MODEL.md`, `docs/DEPLOY.md`, `docs/TASKS.md`, `CLAUDE.md` e
  `runtime/.env.example` atualizados conforme as decisões.

- `seeds/exercises_ptbr.csv`: 104 exercícios comuns com nome PT-BR, apelidos, tipo de carga, incremento e músculos
  (revisado e aprovado pelo dono).

#### Pendente
- Itens em aberto para as próximas fases listados em `docs/DECISIONS.md` (retry sem duplicar, `query_sql` em
  worker, chaves de meta, confiança agregada etc.).
