# CLAUDE.md — Impetus (memória do projeto para desenvolvimento)

Assistente pessoal de treino, nutrição e saúde via Telegram para **um usuário**. Roda numa VM Oracle A1 (arm64) gratuita. O "cérebro" em produção é o Claude Code headless (`claude -p`), que acessa dados apenas por tools MCP deste app.

> Este arquivo orienta **você, Claude Code, desenvolvendo o projeto**. Ele **não** é lido pelo coach em produção (o coach roda com cwd `BRAIN_DIR`, fora do repositório, e `--system-prompt-file runtime/prompts/system.md`).

## Fonte da verdade
Leia antes de implementar qualquer fase e siga à risca. Em conflito, a ordem de precedência é: `docs/TASKS.md` (escopo da fase) > `docs/ARCHITECTURE.md` > `docs/DATA_MODEL.md` / `docs/TOOLS.md` > `docs/SPEC.md`. Se uma spec estiver errada ou inviável, **pare e explique** antes de desviar; registre a decisão em `docs/DECISIONS.md`.

## Stack
Node 24 LTS (TypeScript nativo, sem tsx) · TypeScript 6 ESM estrito · better-sqlite3 (WAL) · zod · @modelcontextprotocol/sdk (streamable HTTP) · hono · Telegram Bot API (long polling) · baileys (legado, versão fixada) · croner · p-queue · execa · sharp · pino · vitest.

## Comandos
- `npm run dev`: app com canal definido em `CHANNEL` (use `terminal` localmente)
- `npm run chat`: REPL no terminal com o cérebro real
- `npm run check`: typecheck + lint + testes (**deve passar antes de concluir qualquer tarefa**)
- `npm run db:migrate` / `npm run db:seed`
- `npm run eval`: evals contra o cérebro real (consome cota; rode só quando pedido ou ao fechar a Fase 3/5)
- `npm run simulate -- evals/personas/<nome>.md`: persona simulada por dias + rubrica de tom por LLM-juiz (consome cota; só quando pedido)
- `npm run wa:link`: legado (canal WhatsApp/Baileys, não usado em produção)

TypeScript roda direto no Node (type stripping): imports relativos com `.ts`, `import type` para tipos, sem `enum`/`namespace`/parameter properties (ver `docs/DECISIONS.md` D-003).

## Regras de arquitetura
1. **Matemática no código.** Macros, somas, e1RM, médias, tendências e correlações são funções puras em `src/domain/` com testes. O LLM nunca calcula.
2. **Toda escrita passa por `tools/registry`** (ou por handler de comando), com validação zod, `audit_log` e `turn_id`.
3. **Domínio sem I/O de rede.** `domain/` recebe dados e devolve dados.
4. **Tempo:** armazene UTC ISO; agregue por `local_date` (fuso America/Sao_Paulo, virada às `DAY_CUTOFF_HOUR`). Use `src/time.ts`, nunca `new Date().toISOString().slice(0,10)` para o dia.
5. **Unidades fixas:** kg, m, kcal, g, s. Conversões só nas bordas.
6. **Soft delete** (`deleted_at`) e filtro padrão nos repositórios.
7. **Canal abstrato:** nada fora de `channels/` importa `baileys` nem fala com a API do Telegram. Produção: `CHANNEL=telegram`.
8. **Cérebro plugável:** nada fora de `brain/` sabe que existe uma CLI `claude`.
9. **Segurança:** MCP e ingest só em 127.0.0.1; token de turno obrigatório; allowlist do dono; sem segredos em logs (redija tokens, chaves e conteúdo de `wa-auth`).
10. **Sem dados inventados nos seeds.** TACO e medidas caseiras vêm das fontes oficiais; valor não confirmado não entra.

## Convenções de código
- Nomes de código em inglês; textos ao usuário em PT-BR (centralizados em `src/i18n/pt-br.ts`).
- Arquivos pequenos e coesos; funções puras quando possível; sem classes onde uma função basta.
- Erros esperados retornam envelope `{ ok:false }`; exceções só para o inesperado.
- SQL em repositórios (`src/db/repos/`), com statements preparados e reutilizados.
- Logs estruturados (`logger.child({ turnId })`).
- Testes: unit para domínio e métricas (fixtures com números conhecidos); integration para tools com banco temporário (`:memory:` + migrations); snapshot para o fallback de relatórios.

## Fluxo de trabalho
- Trabalhe **fase a fase** (`docs/TASKS.md`). No início de cada fase, liste o plano em tarefas; no fim, rode `npm run check`, atualize `CHANGELOG.md` e reporte o que foi feito, o que ficou de fora e os riscos.
- Commits pequenos e descritivos (Conventional Commits).
- Antes de adicionar uma dependência, verifique se é necessária, se tem binário linux-arm64 (quando nativa) e se é mantida. **Nunca** instale pacotes "baileys-*" de terceiros (anti-ban etc.).
- Ao gerar dados de seed que exigem julgamento (ex.: `exercises_ptbr.csv`), **pare e peça revisão** do usuário antes de commitar.
- Comportamento do coach (tom, formatos, protocolo) mora em `runtime/prompts/*.md`. Mudanças ali exigem rodar os evals afetados.
