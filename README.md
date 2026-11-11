# Impetus

Agente de IA pessoal de treino, nutrição e saúde que conversa pelo Telegram. Ele registra refeições (por texto ou foto), treinos e dados do relógio, e manda relatórios e um check-in pela manhã. Foi feito para um único usuário, com custo zero além da assinatura do Claude.

Projeto pessoal, desenvolvido com Claude Code a partir de uma especificação escrita antes do código (`docs/`).

## Como funciona

```
Telegram / terminal
        │
        ▼
   gateway (Node.js) ── debounce, roteamento de modelo, contexto do turno
        │
        ▼
   cérebro: Claude (LLM) via `claude -p`
        │  tool calling
        ▼
   servidor MCP próprio ──► domínio + SQLite (refeições, treinos, saúde, metas)
```

- **Agente com ferramentas (MCP):** o LLM não escreve no banco diretamente. Ele chama ferramentas expostas por um servidor MCP que roda no mesmo processo, e o gateway sabe a qual turno cada escrita pertence. Isso permite desfazer ou corrigir um registro respondendo à mensagem do bot.
- **Contexto montado por turno:** cada chamada recebe as últimas mensagens com data, um resumo do dia e regras de produto, para o modelo não "adivinhar" datas ou totais.
- **Roteamento de modelo:** tarefas simples vão para um modelo mais barato, e as que exigem raciocínio vão para um maior, economizando cota.
- **Memória de longo prazo:** as conversas viram um diário em Markdown (cofre Obsidian), e toda noite o agente organiza metas, objetivos e ideias em notas, com um conjunto de ferramentas separado do chat.
- **Interface plugável:** canal (Telegram, terminal; WhatsApp via Baileys foi usado no início) e provedor de LLM são adaptadores trocáveis.

## Nutrição com IA, sem chute

Estudos indicam erro alto quando um LLM estima calorias só pela foto. Por isso a estimativa é feita em duas etapas: o modelo primeiro identifica os alimentos e as porções, e o código calcula os valores com base na tabela brasileira **TACO** e em medidas caseiras do IBGE. Cada item guarda a origem do valor (informado pelo usuário, estimado pelo texto ou pela foto).

## Avaliação (evals)

- **Casos de teste do agente** (`evals/cases/`): mensagens reais de uso com a resposta esperada, rodados com `npm run eval`.
- **Simulação por personas** (`evals/personas/`): um LLM faz o papel do usuário ao longo de vários dias, contra o gateway real, com banco em memória e relógio simulado. Um **LLM-juiz** dá nota de 1 a 5 em 8 critérios de tom e memória, e a simulação falha se algum turno der erro ou tiver nota baixa. Os problemas encontrados assim viraram correções e novos casos de teste (ver `CHANGELOG.md`).
- **Testes automatizados** de unidade e integração com Vitest.

## Stack

TypeScript, Node.js, Claude (Claude Code em modo headless), MCP (Model Context Protocol), SQLite, Telegram Bot API, Vitest. Dados de saúde chegam do relógio via Health Connect.

## Rodar localmente

Requer Node (versão em `.nvmrc`) e o Claude Code autenticado.

```bash
npm install
cp runtime/.env.example .env   # preencha as variáveis
npm run db:migrate && npm run db:seed
npm run chat                   # conversa pelo terminal, sem WhatsApp
npm run check                  # typecheck, lint e testes
```

## Documentação

| Arquivo | Conteúdo |
|---|---|
| `docs/SPEC.md` | Produto: objetivos, casos de uso, conversas de exemplo |
| `docs/ARCHITECTURE.md` | Componentes, fluxos, decisões e riscos |
| `docs/DATA_MODEL.md` | Esquema do banco |
| `docs/TOOLS.md` | Contratos das ferramentas MCP |
| `docs/NUTRITION.md` | Protocolo de estimativa de refeições |
| `docs/DECISIONS.md` | Registro de decisões ao longo do projeto |
| `CHANGELOG.md` | Histórico por fase |

## Decisões principais

| Tema | Decisão | Motivo |
|---|---|---|
| Canal | **Telegram** (Bot API, long polling), com adaptador de canal abstrato | Gratuito, sem número/chip dedicado, mensagens proativas sem janela de 24h. WhatsApp (Baileys) foi abandonado: o chip pré-pago exigia renovação a cada 15 dias (D-038) |
| Cérebro | **`claude -p`** (headless) chamado pelo gateway a cada turno, com provider plugável | Usa a sua assinatura; Channels oficiais ainda são *research preview* e não suportam WhatsApp (por isso o gateway próprio) |
| Tools | Servidor **MCP HTTP local** dentro do próprio processo | Um processo só, sem spawn por chamada; o gateway sabe a qual turno cada escrita pertence (undo, correções) |
| Dados | **SQLite** (WAL) + arquivos de mídia locais | Zero infraestrutura, backup é copiar um arquivo |
| Nutrição | Protocolo em 2 etapas + **TACO** + priors pessoais | Estudos mostram ~36% de erro médio de LLMs só com foto; decompor e aterrar numa tabela reduz o erro |
| Saúde | Mi Fitness → Health Connect → **HC Webhook** (app grátis) → endpoint próprio | O Health Connect não tem API em nuvem; o app ponte resolve sem código Android |
| Hospedagem | **Oracle A1** (2 OCPU / 12 GB, limite Always Free atual) | Cabe tudo; fallback em E2.1.Micro com swap |
| Matemática | Sempre em **código**, nunca no LLM | Macros, e1RM, médias e tendências são determinísticos e testáveis |

O antigo guia de desenvolvimento em fases está em `KICKOFF.md` e `docs/TASKS.md`.
