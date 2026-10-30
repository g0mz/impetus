# AGENTS.md — Impetus

Assistente pessoal de treino, nutrição e saúde (canal Telegram) para um usuário. Em produção roda numa VM Oracle; aqui você só desenvolve o código.

**Antes de qualquer tarefa, leia `CLAUDE.md`** (regras de arquitetura, stack, convenções, fluxo de trabalho). As specs estão em `docs/`; em conflito vale `docs/TASKS.md` > `ARCHITECTURE.md` > `DATA_MODEL.md`/`TOOLS.md` > `SPEC.md`.

Resumo do essencial:
- `npm run check` (typecheck + lint + testes) deve passar antes de concluir qualquer tarefa.
- Matemática (macros, e1RM, tendências) só em `src/domain/`, nunca no LLM.
- Toda escrita passa por `src/tools/registry`. Nada fora de `channels/` importa `baileys`.
- Textos ao usuário em PT-BR (`src/i18n/pt-br.ts`); código em inglês.
- Não rode `npm run eval` nem `npm run simulate` sem pedido (consomem cota).
- Não mexa na VM de produção nem em segredos; não instale pacotes `baileys-*` de terceiros.
- Commits pequenos, Conventional Commits.
