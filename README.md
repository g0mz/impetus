# Impetus — Spec Kit

Assistente pessoal de treino, nutrição e saúde via Telegram, para **um único usuário**, com **custo zero** além da assinatura do Claude que você já paga.

Este kit é o pacote de especificação que você entrega ao Claude Code para desenvolver o projeto do zero.

## Como usar

1. Crie um repositório vazio (`impetus/`) e copie **todo o conteúdo deste kit** para a raiz.
2. Abra o Claude Code na raiz do repositório.
3. Cole o prompt de `KICKOFF.md`. O Claude Code vai ler as specs e executar a **Fase 0** de `docs/TASKS.md`.
4. A cada fase, revise o resultado e use o prompt da fase seguinte (também em `KICKOFF.md`).

## O que tem aqui

| Arquivo | Conteúdo |
|---|---|
| `KICKOFF.md` | Prompts prontos para colar no Claude Code (início e cada fase) |
| `CLAUDE.md` | Memória do projeto para o Claude Code: stack, convenções, regras, comandos |
| `docs/SPEC.md` | Produto: objetivos, não-objetivos, casos de uso e conversas de exemplo |
| `docs/ARCHITECTURE.md` | Componentes, fluxos, decisões (ADRs) e riscos |
| `docs/DATA_MODEL.md` | Schema SQLite completo |
| `docs/TOOLS.md` | Contratos das tools MCP que o cérebro (Claude) usa |
| `docs/NUTRITION.md` | Protocolo de estimativa de refeições (texto + foto) |
| `docs/REPORTS.md` | Métricas, fórmulas, detectores de insight e relatórios |
| `docs/DEPLOY.md` | Oracle Cloud, autenticação do Claude Code, systemd, rede, backup |
| `docs/TASKS.md` | Plano faseado com critérios de aceite |
| `docs/REFERENCES.md` | Fontes da pesquisa que embasou as decisões |
| `runtime/` | Arquivos usados pelo app em produção: system prompt do coach, `.env.example`, unit do systemd |

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

## Custos

| Item | Custo |
|---|---|
| Oracle A1 dentro do Always Free | R$ 0 |
| Telegram Bot API | R$ 0 |
| HC Webhook, TACO, free-exercise-db, Open Food Facts | R$ 0 |
| Claude | Consome a cota da sua assinatura atual |
| Chip secundário | O que você já pagar no plano pré |

## Riscos que você está aceitando

- **Token do bot:** `TELEGRAM_BOT_TOKEN` é credencial; fica só no ambiente da VM e nunca em logs. Só o dono pareado é atendido.
- **Regras de cobrança do `claude -p`:** a Anthropic anunciou e depois suspendeu em 2026 a separação do uso programático da cota da assinatura. Hoje o `-p` consome a assinatura, mas o cérebro é plugável (API ou Gemini) caso isso mude.
- **Precisão nutricional:** estimativa por foto serve para tendência, não para medida exata. O protocolo minimiza o erro, não o elimina.
