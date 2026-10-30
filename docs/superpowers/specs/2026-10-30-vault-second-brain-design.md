# Cofre Obsidian como segundo cérebro — design

**Data:** 2026-10-30 · **Fase:** 9 · **Estado:** rascunho para revisão do dono

## Problema

O Impetus guarda treino, nutrição e saúde em SQLite, mas o resto da vida do dono (metas, estudos, projetos, ideias)
não tem lugar. O objetivo é um assistente pessoal único: **tudo o que é dito no Telegram fica salvo e entra no
Obsidian**, ligado ao que já se sabe (projetos, matérias, metas), com o grafo do Obsidian como forma de revisar e
navegar. O dono também escreve no Obsidian, e o bot precisa conseguir consultar isso.

Um usuário. Telegram para o dia a dia, Obsidian para ver, escrever e revisar.

## Decisões (confirmadas pelo dono em 2026-10-30)

| Decisão | Alternativas descartadas |
|---|---|
| **Todas** as mensagens do Telegram entram num log bruto do dia; o cérebro liga o que for relevante | Só o classificado como nota; só com `/nota` |
| Cofre de produção na **VM Oracle**, sincronizado por Syncthing com PC e celular | Cofre no PC; repositório git privado |
| O bot lê o cofre **sob demanda** (tools de busca e leitura), sem importar para o banco | Importar tudo para o SQLite; importar só notas marcadas |
| MVP: **só Telegram → log diário com links automáticos** | Começar por cofre → bot ou por notas geradas do banco |

## Princípios

1. **SQLite segue sendo a fonte de verdade dos dados estruturados** (refeições, treinos, peso, notas do coach). O
   cofre guarda texto e conhecimento; não duplica números do banco. O `.db` nunca entra na pasta sincronizada.
2. **Cada arquivo tem um dono.** Arquivos do bot só o bot escreve; arquivos do dono só o dono escreve. Isso evita
   conflito no Syncthing. O bot nunca edita texto do dono.
3. Toda escrita no cofre passa por um módulo único (`src/vault/`), com `audit_log` e `turn_id` (regra 2 do
   CLAUDE.md). `domain/` continua sem I/O.
4. Ligações automáticas são **código determinístico**, não LLM, no MVP.

## Estrutura do cofre

```
Impetus Vault/
├── Diario/
│   ├── Log/AAAA-MM-DD.md   # DONO: bot (append-only). Mensagens do dia.
│   └── AAAA-MM-DD.md       # DONO: usuário. Nota diária; linka o log do dia.
├── 00-Inbox/               # usuário e bot (arquivos novos, nunca edição cruzada)
├── 10-Disciplinas/  20-Projetos/  30-Wiki/  40-Referencias/  Perfil/  Templates/
```

## MVP — Telegram → log diário

### Formato do log (`Diario/Log/AAAA-MM-DD.md`)

```markdown
---
type: log
date: 2026-10-30
tags: [log]
---
# Log 2026-10-30
- 07:41 **eu:** acordei 7h, vou treinar [[Lower A]] hoje
- 07:41 **bot:** Bom treino! ...
- 14:05 **eu:** ideia pro [[Impetus]]: ligar o [[Hackathon Nort Hub 2026]] ...
```

- O "dia" segue `local_date` (America/Sao_Paulo, virada em `DAY_CUTOFF_HOUR`), via `src/time.ts`.
- Entram mensagens do dono e a resposta final do bot. Foto vira `[foto]`, áudio entra como a transcrição.
- Resposta do bot longa é truncada no log (limite configurável); o texto completo continua em `messages`.
- Comandos `/` não entram no log, exceto `/nota` quando existir.

### Links automáticos

`src/vault/linker.ts` indexa título e `aliases` (frontmatter) das notas de `Perfil/`, `10-Disciplinas/`,
`20-Projetos/` e `30-Wiki/`, e envolve em `[[ ]]` a primeira ocorrência de cada termo por linha. Regras:
sem diferenciar maiúsculas, palavra inteira, nunca dentro de código ou de link existente, termos com menos de 3
letras ignorados. O índice é recarregado quando o `mtime` de uma pasta muda.

### Arquivos novos

- `src/vault/log.ts`: `appendLog({ at, who, text, turnId })`. Cria o arquivo do dia com frontmatter se não existir.
  Escrita por `appendFile` (atômica o bastante para linha única). Falha no cofre **nunca** derruba o turno: loga
  aviso e segue.
- `src/vault/linker.ts`: indexação e `linkText(text)`. Puro, com testes.
- Config: `VAULT_DIR` (opcional; sem ele, tudo isto fica desligado) e `VAULT_LOG_MAX_REPLY` (padrão 400).
- Gancho no `turn-runner` depois do envio da resposta.

### Testes

Unit: linker (casos de borda acima). Integration: turno no canal `terminal` com `VAULT_DIR` temporário gera o log
esperado; cofre indisponível não quebra o turno; virada do dia respeita `DAY_CUTOFF_HOUR`.

## Fases seguintes (fora do MVP)

1. **Cofre → bot:** tools MCP de leitura (`vault_search`, `vault_read`), restritas a `VAULT_DIR`, só leitura, sem
   `Privado/`. Entram no prompt como mais uma fonte; o cérebro cita a nota usada.
2. **Banco → cofre:** notas geradas (resumo semanal de treino e nutrição, progressão de carga) em `30-Wiki/gerado/`,
   regeneráveis, marcadas `<!-- agente -->`.
3. **Revisão:** job semanal que lê o log, propõe notas permanentes e conexões e deixa o resultado no Inbox.
4. **Ligação por LLM:** sugerir links e tags que o linker determinístico não pega.

## Riscos

| Risco | Mitigação |
|---|---|
| Conflito de Syncthing | Donos separados por arquivo; log só com append; `.stignore` já exclui workspace e cache |
| Saúde e família sincronizadas com VM e celular | Pasta `Privado/` fora do Syncthing e fora das tools de leitura; **decidir o que vai nela** |
| Log vira ruído | Só texto curto; revisão semanal promove o que importa |
| Cofre cheio de links falsos | Primeira ocorrência por linha, lista de termos curta e revisável |
| Prompt injection via notas do cofre (fase 1) | Conteúdo lido entra em tag própria, tratado como dado; escrita só por tools do registry |

## Perguntas em aberto

- O log inclui dados de saúde ditos no chat (peso, sono)? Proposta: sim, o cofre é privado; revisar quando houver `Privado/`.
- Resposta do bot no log: só o início ou nenhuma? Proposta: início truncado.
