# Cofre Obsidian como segundo cérebro — design

**Data:** 2026-10-30 · **Fase:** 9 · **Estado:** aprovado pelo dono em conversa; aguarda leitura do spec escrito

Este documento unifica o rascunho anterior (`fd28298`) com as decisões da sessão de brainstorming de 2026-10-30
e a revisão técnica (Opus, esforço alto). Onde houve conflito, valem as decisões desta versão.

## Problema

O Impetus guarda treino, nutrição e saúde em SQLite, mas o resto da vida do dono (metas, estudos, projetos, ideias)
não tem lugar. Objetivo: um assistente pessoal único. **Tudo o que é dito no Telegram fica salvo e entra no
Obsidian**, ligado ao que já se sabe, com o grafo do Obsidian como forma de revisar e navegar. Um usuário.

## Decisões

| Decisão | Descartado |
|---|---|
| Cofre na **VM**, sincronizado com PC e Android por **Syncthing** (grátis; iPhone não suportado) | Obsidian Sync (pago), Git |
| Captura = **diário bruto sempre** + **notas organizadas** por cima | Só bruto; só organizado |
| Organização **uma vez por noite** (job), não a cada mensagem | A cada mensagem; sob demanda |
| Nomes de pasta e arquivo em **minúsculas e sem acento**; texto das notas normal | `Diario/Log/` com maiúsculas |
| Diário **gerado em código** (sem IA); organização pelo coach via tools MCP restritas | Coach escrevendo direto nos arquivos; banco regenerando o cofre |
| Sem gancho no gateway: **job periódico** refaz o diário | Gancho no `turn-runner` |

## Princípios

1. SQLite continua sendo a fonte de verdade dos dados estruturados. O `.db` nunca entra na pasta sincronizada.
2. **Cada arquivo tem um dono.** Diário: só o bot (gerado). Notas com `origem: impetus`: só o bot, só acrescentando.
   Todo o resto do cofre: só o dono. O bot nunca edita texto do dono.
3. Escrita no cofre só por `src/vault/` (borda fina de I/O) com render puro; as tools de organização passam por
   `tools/registry` com zod, `audit_log` e `turn_id` (regra 2). `domain/` continua sem I/O.
4. Falha no cofre nunca derruba turno nem job do bot: loga aviso e segue.
5. Sem `VAULT_DIR`, o cofre inteiro fica desligado e o bot se comporta como hoje.

## Estrutura

```
<VAULT_DIR>/impetus/
├── diario/AAAA-MM-DD.md     # gerado, só o bot
├── metas/  objetivos/  estudos/  projetos/  ideias/      # notas organizadas (Fase 9b)
└── treino/  nutricao/  corpo/                            # geradas do banco (fase posterior)
```

O dono pode ter outras pastas fora de `impetus/`; o bot não as escreve.

## 9a — Diário bruto

`src/vault/diary.ts` (render puro) e `src/vault/fs.ts` (escrita). Lê `messages` e gera `impetus/diario/AAAA-MM-DD.md`.

- **Quando:** job a cada 5 min (`vault.diary`) refaz hoje e ontem, mas só se `max(messages.id)` mudou desde a última
  execução. Sem gancho no gateway. O dia segue `local_date` (America/Sao_Paulo, virada às `DAY_CUTOFF_HOUR`) via
  `src/time.ts`. A resposta fica no dia da primeira mensagem de entrada do mesmo `turn_id`, para um turno que cruza a
  virada não ser partido.
- **Conteúdo:** uma linha por mensagem (`- 07:41 **eu:** ...` / `**bot:**`). Áudio vira `[áudio] <transcrição>`,
  foto vira `[foto] <legenda>`; `media_path` nunca aparece. Reação vira o emoji no fim da linha anterior.
- **Fora do diário:** entradas que começam com `/`, a mensagem de pareamento, respostas de turnos `failed` ou
  `deferred`, saídas com `turn_id` nulo e relatórios agendados (saem por `notify`, sem `insertMessage`; limitação
  aceita no MVP).
- **Arquivo gerado:** frontmatter `gerado: true`, `tags: [diario]`. Texto do usuário é escapado (`# [ ] |`, `[[`),
  continuações de várias linhas indentadas, e o arquivo nunca começa com `---` fora do frontmatter. O render aplica ao
  texto a mesma redação de tokens e chaves do logger.
- **Escrita:** grava em arquivo temporário no mesmo diretório e faz `rename`; só escreve se o hash do conteúdo mudou
  (não mexe no `mtime`, não dispara o Syncthing à toa). `.stignore` exclui `*.tmp`.
- **Backfill:** `npm run vault:backfill` gera os diários dos dias já existentes no banco.

## 9b — Organização noturna

- **Job** `vault.organize` às 04:30 (`VAULT_ORGANIZE_CRON`), uma chamada ao coach por noite com `MODEL_REPORT`.
  O setting `vault.organized_through` guarda o último dia organizado; noite falha é recuperada na seguinte.
- **Entrada:** diário do dia fechado + índice das notas de `impetus/` (título, aliases, caminho). O diário entra em
  tag própria, tratado como dado, nunca como instrução. Prompt em `runtime/prompts/vault-organize.md`.
- **Tools** (só em `impetus/`; recusam `..`, caminho absoluto e pastas fora da lista):
  - `vault_list`: índice de notas.
  - `vault_read`: lê uma nota.
  - `vault_upsert`: cria nota (frontmatter com `origem: impetus`) ou **acrescenta** uma entrada datada em nota que
    tenha `origem: impetus`. Cada entrada linka `[[diario/AAAA-MM-DD]]` e as notas relacionadas.
- **Posse:** nota sem `origem: impetus` é do dono; o coach não toca, só cita no resumo. O dono assume uma nota do bot
  apagando essa linha.
- **Limites:** máximo `VAULT_ORGANIZE_MAX_NOTES` notas novas por noite (padrão 10) e tamanho máximo por nota.
- **Controle:** cada alteração vai para o `audit_log`. Um comando `/cofre` listando o da última noite é desejável;
  desfazer fica para depois.
- Escreve em `metas`, `objetivos`, `estudos`, `projetos`, `ideias`. `treino`, `nutricao` e `corpo` ficam para a fase
  em que o banco gera notas.

## 9c — Sincronização

Instalar Syncthing na VM (memória: dezenas de MB; hoje há ~490 MB livres com `MemoryMax=900M`), parear com PC e
Android, `.stignore` com `*.tmp` e `.obsidian/workspace*`. É a única etapa que mexe em produção: exige confirmação
do dono antes. Validar `VAULT_DIR`: absoluto, fora do repositório e do `DATA_DIR` (como `BRAIN_DIR`).

## Fases seguintes

1. **Cofre → bot:** tools de busca e leitura nas conversas, só leitura, citando a nota usada.
2. **Banco → cofre:** notas geradas de treino e nutrição, regeneráveis.
3. **Revisão semanal:** job que propõe notas permanentes e conexões.
4. **Ocultar mensagem:** `messages.hidden_at` e comando, para o dono tirar algo do diário (hoje não há soft delete
   em `messages`).

## Configuração

`VAULT_DIR` (opcional), `VAULT_ORGANIZE_MAX_NOTES` (10), `VAULT_ORGANIZE_CRON` (`30 4 * * *`).

## Testes

- Unit: render do diário (snapshot), filtros, virada das 4h, escape de markdown, redação de tokens.
- Integration (banco `:memory:` + pasta temporária): só regrava quando muda; tools recusam caminho fora de
  `impetus/` e nota sem `origem: impetus`; job noturno recupera noite perdida; cofre indisponível não quebra turno.
- Eval do coach para a organização, só sob pedido (consome cota).

## Riscos

| Risco | Mitigação |
|---|---|
| Conflito de Syncthing | Donos por arquivo; diário só gerado; escrita atômica e só quando muda |
| Saúde em texto puro no celular e no PC (o backup é cifrado) | Registrar em `DECISIONS.md`; redação de tokens; dono ciente |
| Notas com links falsos | Limite por noite, só acrescenta, `audit_log`, dono pode assumir ou apagar |
| Prompt injection pelo diário ou por notas | Conteúdo em tag de dado; escrita só por tools do registry restritas |
| Syncthing em 1 GB | Monitorar memória após a 9c; `MemoryMax` já protege o bot |
