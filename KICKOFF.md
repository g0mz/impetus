# KICKOFF — Prompts para o Claude Code

Use no Claude Code, na raiz do repositório com este kit copiado. Sugestão: comece cada fase em **plan mode** (Shift+Tab até "plan") e aprove o plano antes da implementação.

---

## Prompt inicial (Fase 0)

```
Você vai construir o FitCoach do zero. Este repositório contém a especificação completa.

1. Leia, nesta ordem: CLAUDE.md, docs/SPEC.md, docs/ARCHITECTURE.md, docs/DATA_MODEL.md,
   docs/TOOLS.md, docs/NUTRITION.md, docs/REPORTS.md, docs/TASKS.md, docs/DEPLOY.md e
   runtime/prompts/system.md.
2. Antes de escrever código, me dê:
   - um resumo de 10 linhas do que entendeu;
   - inconsistências, lacunas ou riscos que encontrou nas specs (seja crítico);
   - as perguntas que realmente bloqueiam a Fase 0 (no máximo 5).
3. Depois que eu responder, execute somente a Fase 0 de docs/TASKS.md.
   - Para seeds/exercises_ptbr.csv, gere a proposta e PARE para eu revisar antes de commitar.
   - Para seeds/portions_ibge.csv, use só valores que você conseguir conferir na fonte oficial;
     se não conseguir acessar a fonte, deixe o arquivo com cabeçalho e me avise.
4. Ao final: rode npm run check, atualize CHANGELOG.md e me mostre o checklist de aceite
   da Fase 0 com o status de cada item.

Regras: siga CLAUDE.md. Matemática no código, nunca no LLM. Não invente dados nutricionais.
Se uma decisão das specs parecer errada, pare e explique antes de desviar; registre em
docs/DECISIONS.md.
```

## Fase 1

```
Execute a Fase 1 de docs/TASKS.md (cérebro + tools de treino + canal terminal).
- Implemente a invocação do `claude -p` exatamente como docs/ARCHITECTURE.md §5.1.
  Antes, rode `claude --version` e `claude -p --help` e confira se as flags existem nesta versão;
  ajuste e registre em docs/DECISIONS.md se algo mudou.
- O processo filho roda com cwd data/brain/ (pasta vazia, sem CLAUDE.md).
- Escreva testes de integração das tools com banco em memória.
- Valide os 6 critérios de aceite rodando `npm run chat` e cole a transcrição no resumo final.
```

## Fase 2

```
Execute a Fase 2 de docs/TASKS.md (WhatsApp via Baileys).
- Use somente o pacote oficial `baileys` (WhiskeySockets), versão fixada.
  Leia o README e o changelog da versão escolhida antes de codar (pairing code, LID, mídia, citações).
- Implemente o pareamento do dono (PAREAR <código>) e a allowlist por JID + LID.
- Debounce conforme ARCHITECTURE.md §4.2; fila serial; reação 👀 e "digitando…".
- Teste com o canal terminal tudo o que não depender do WhatsApp real; me passe um roteiro
  de teste manual pelo celular para o resto.
```

## Fase 3

```
Execute a Fase 3 de docs/TASKS.md (nutrição).
- Siga docs/NUTRITION.md à risca; o protocolo de 9 passos vive em runtime/prompts/system.md.
- Macros, confiança agregada, priors (mediana/p25/p75) e calibração de viés no código, com testes.
- Crie evals/cases/meals_*.yaml (~12 casos) e scripts/eval.ts. Para casos com foto, me peça as
  imagens; não use imagens da internet.
- Rode o eval uma vez ao final e me mostre o resultado por caso.
```

## Fase 4

```
Execute a Fase 4 de docs/TASKS.md (Health Connect via HC Webhook).
- Implemente ingest/http.ts e a normalização conforme DATA_MODEL.md §4.
- Antes de fechar o mapeamento do sono, me peça um payload real (vou configurar o app
  apontando para um endpoint de captura temporário) e salve-o anonimizado como fixture.
```

## Fase 5

```
Execute a Fase 5 de docs/TASKS.md (relatórios e insights).
- Métricas e detectores como funções puras com testes de fixture (semana sintética com números conhecidos).
- ReportBrief → turno de relatório (toolScope='read', runtime/prompts/report.md) → envio; fallback determinístico.
- Scheduler com croner no fuso America/Sao_Paulo, idempotente após reinício (job_runs).
- 5b (gráficos) só depois do resto estar verde.
```

## Fase 6

```
Execute a Fase 6 de docs/TASKS.md (deploy).
- Gere deploy/setup-vm.sh idempotente seguindo docs/DEPLOY.md e me guie passo a passo na VM
  (eu executo os comandos e colo as saídas).
- Configure o backup e conduza comigo um teste de restore completo.
- Ao final, me entregue docs/RUNBOOK.md com as operações do dia a dia.
```

---

## Dicas de uso do Claude Code neste projeto

- Mantenha uma sessão por fase; ao trocar de fase, comece uma conversa nova (o contexto fica nas specs e no CHANGELOG).
- Se o Claude Code começar a desviar das specs, peça: "releia docs/<arquivo>.md e compare com o que você fez".
- Para revisar código ao fim de cada fase: "revise o diff desta fase contra CLAUDE.md e as specs; liste problemas por severidade".
