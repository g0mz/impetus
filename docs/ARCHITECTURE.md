# ARCHITECTURE — Impetus

## 1. Visão geral

Um único processo Node.js (`impetus`) roda na VPS sob systemd. O "cérebro" é o Claude Code em modo headless (`claude -p`), chamado a cada turno, e acessa os dados **somente** por tools MCP expostas pelo próprio processo.

```
 Celular (dono)                         VPS Oracle A1 (Ubuntu 24.04 arm64)
 ┌──────────────┐                 ┌────────────────────────────────────────────────────┐
 │ WhatsApp     │◄──── WA Web ───►│ impetus (Node 24, 1 processo)                      │
 │ (seu número) │   (Baileys)     │                                                    │
 └──────────────┘                 │  channels/whatsapp ─► gateway/inbox ─► debounce     │
                                  │                            │                       │
 ┌──────────────┐                 │              ┌─────────────┴─────────────┐         │
 │ Redmi Watch  │                 │              ▼                           ▼         │
 │  → Mi Fitness│                 │        commands (/…)              brain/runner     │
 │  → Health    │   HTTPS/tailnet │        (determinístico)          spawn `claude -p` │
 │    Connect   │───────────────► │  ingest/http :8787 ─► domain     │       ▲         │
 │  → HC Webhook│   POST JSON     │                                  ▼       │ MCP HTTP│
 └──────────────┘                 │                         mcp/server 127.0.0.1:8788  │
                                  │                                  │                 │
                                  │  scheduler (croner) ─► reports ──┤                 │
                                  │                                  ▼                 │
                                  │                       domain/* ─► SQLite (WAL)     │
                                  │                                   data/media/      │
                                  └────────────────────────────────────────────────────┘
                                                  │ backup diário (rclone crypt)
                                                  ▼
                                            Google Drive
```

## 2. Componentes

| Módulo | Responsabilidade |
|---|---|
| `channels/` | Interface `Channel` (receber, enviar texto e imagem, reagir, "digitando", baixar mídia). Implementações: `whatsapp-baileys` (produção) e `terminal` (desenvolvimento e testes). `telegram` é opcional (Fase 7). |
| `gateway/inbox` | Persiste toda mensagem recebida (idempotente pelo id externo), aplica a allowlist do dono e encaminha. |
| `gateway/debounce` | Agrupa mensagens próximas num único **turno** (§4.2). |
| `gateway/commands` | Parser e handlers dos comandos `/`, sem LLM. |
| `gateway/queue` | Fila serial (concorrência 1) de turnos para o cérebro. |
| `brain/` | `ContextBuilder` monta o prompt do turno; `ClaudeCliBrain` executa `claude -p`; interface `Brain` permite outros providers. |
| `mcp/` | Servidor MCP *streamable HTTP* em `127.0.0.1`, que expõe as tools de `tools/registry`. Valida o token por turno. |
| `tools/` | Registro único de tools (schema zod + handler). Servido via MCP e reutilizável por providers de API. |
| `domain/` | Regras de negócio puras: treino, nutrição, saúde, métricas, progressão, insights. Sem I/O de rede. |
| `db/` | Conexão better-sqlite3, migrations SQL versionadas, repositórios. |
| `ingest/` | HTTP (Hono) para o HC Webhook. Autentica por header, guarda o payload bruto e normaliza. |
| `scheduler/` | Jobs cron no fuso America/Sao_Paulo: relatórios, alertas, backup. |
| `media/` | Download, normalização (sharp) e armazenamento de imagens. |
| `charts/` | Vega-Lite → SVG → PNG (resvg) para relatórios (Fase 5b). |

## 3. Stack

| Camada | Escolha |
|---|---|
| Runtime | Node.js 24 LTS, TypeScript (ESM) executado nativamente em dev e scripts, `tsc` no build (D-003) |
| WhatsApp | `baileys` (WhiskeySockets), **versão fixada** no lockfile |
| DB | `better-sqlite3` com WAL, `busy_timeout=5000`, `foreign_keys=ON`, FTS5 |
| Validação | `zod` |
| MCP | `@modelcontextprotocol/sdk` (servidor streamable HTTP) |
| HTTP | `hono` + `@hono/node-server` |
| Cron | `croner` (suporta timezone) |
| Fila | `p-queue` |
| Processos | `execa` (para spawn do `claude`) |
| Imagens | `sharp` |
| Logs | `pino` (JSON) com `pino-pretty` em dev |
| Testes | `vitest` |
| Gráficos | `vega`, `vega-lite`, `@resvg/resvg-js` (Fase 5b) |

Todas as dependências nativas (`better-sqlite3`, `sharp`, `@resvg/resvg-js`) têm binários para linux-arm64. Confirme no build da Fase 6.

## 4. Fluxos

### 4.1 Mensagem recebida

1. O Baileys entrega a mensagem. Se o remetente não está na allowlist, ela é **descartada em silêncio** (só log em nível debug).
2. `inbox` grava em `messages` (`direction='in'`), deduplicando por `external_id`.
3. Se houver imagem: baixa, normaliza (lado maior ≤ 1568 px, JPEG q85, remove EXIF) e salva em `data/media/YYYY/MM/<uuid>.jpg`.
4. Se o texto começa com `/`, o comando executa na hora e o fluxo termina.
5. Caso contrário, a mensagem vai para o `debounce`.

### 4.2 Debounce (foto e texto que se complementam)

- Cada mensagem livre inicia ou estende um **turno pendente**.
- Janela padrão: **4 s** após a última mensagem.
- Se a última mensagem for **imagem sem legenda**, a janela sobe para **20 s**, porque o texto complementar costuma vir em seguida.
- Mensagens que chegam enquanto um turno está no cérebro iniciam um novo turno. Elas não são injetadas no turno em andamento.
- Configurável: `DEBOUNCE_MS=4000`, `DEBOUNCE_IMAGE_MS=20000`.

### 4.3 Turno no cérebro

1. Reação 👀 na última mensagem do turno e presença "digitando…".
2. Cria um registro em `turns` (`status='running'`) e um **token de turno** aleatório (32 bytes, hex).
3. `ContextBuilder` monta o prompt do turno (§5.2).
4. `ClaudeCliBrain` executa o `claude -p` (§5.1) com timeout de 120 s.
5. As tools chamadas durante a execução chegam ao MCP com `Authorization: Bearer <token>`. O servidor resolve o `turn_id` e grava cada escrita em `audit_log` com esse id.
6. Ao fim, o texto final (`result` do JSON) é enviado ao usuário. O id externo da resposta é ligado às entidades criadas no turno (`message_links`), o que permite correções por citação.
7. `turns` é atualizado com duração, uso e custo estimado (vindos do JSON de saída).
8. Erros: 1 retry após 5 s. Se falhar de novo, a mensagem é marcada `failed`, o usuário recebe "não consegui processar agora, tento de novo em 10 min" e um job reprocessa os turnos falhos. Limite de uso da assinatura atingido vira `status='deferred'`, reprocessado na próxima hora cheia.

### 4.4 Correção por citação

Ao responder citando uma mensagem do bot, o Baileys entrega o `stanzaId` da mensagem citada. O gateway busca em `message_links` as entidades ligadas a ela e injeta no contexto do turno:

```
<quoted entity="meal" id="123">Almoço 13/10 — itens: [1] frango grelhado 150g, [2] arroz branco 140g …</quoted>
```

### 4.5 Ingestão de saúde

`POST /ingest/health` com header `X-Api-Key`. O payload bruto vai para `health_raw` (dedupe por hash SHA-256). A normalização faz *upsert* em `health_samples` e recalcula `health_daily` dos dias afetados (§ DATA_MODEL). Responde `200` rápido; o processamento pesado vai para uma fila interna.

### 4.6 Relatórios agendados

O scheduler executa `reports.build(kind, period)`:
1. Calcula as métricas em código.
2. Roda os detectores de insight.
3. Monta o `ReportBrief` (JSON).
4. Chama o cérebro com o prompt de relatório (só tools de leitura) para redigir.
5. Envia texto e gráficos.

Se o cérebro falhar, envia o **template determinístico** (sem LLM). O relatório nunca deixa de sair.

## 5. Cérebro (`brain/`)

### 5.1 Invocação do Claude Code

```bash
claude -p "<prompt do turno>" \
  --output-format json \
  --model "${MODEL}" \
  --system-prompt-file runtime/prompts/system.md \
  --mcp-config '<JSON inline, abaixo>' \
  --strict-mcp-config \
  --tools "Read" \
  --allowedTools "mcp__fit__*" "Read" \
  --permission-mode dontAsk \
  --add-dir "${DATA_DIR}/media" \
  --max-turns 15 \
  --no-session-persistence
```

MCP inline, gerado por turno:
```json
{"mcpServers":{"fit":{"type":"http","url":"http://127.0.0.1:8788/mcp","headers":{"Authorization":"Bearer <turn-token>"}}}}
```

Regras:
- **Diretório de trabalho do processo filho:** `BRAIN_DIR` (padrão `~/.local/state/impetus/brain`), uma pasta vazia **fora do repositório**. O `claude` procura `CLAUDE.md` subindo a partir do cwd, então uma pasta dentro do repo herdaria o `CLAUDE.md` de desenvolvimento (D-004). `loadConfig` recusa `BRAIN_DIR` dentro do repo.
- **Não usar `--bare`.** O modo bare lê apenas API key ou apiKeyHelper e não usa o token OAuth da assinatura. Verifique na documentação atual antes de mudar.
- `--system-prompt-file` **substitui** o prompt padrão do Claude Code. O coach não é um agente de código; a documentação recomenda substituição nesse caso.
- `--tools "Read"` deixa só o Read como ferramenta nativa, para ver as imagens. Sem Bash, Edit ou WebFetch.
- `dontAsk` nega qualquer coisa fora da allowlist, então a execução nunca trava esperando aprovação. Se a versão instalada não aceitar o curinga `mcp__fit__*`, use a regra por servidor `mcp__fit` (ver *permission rule syntax* na documentação).
- **Imagens:** o prompt do turno referencia o caminho absoluto (`/…/data/media/2026/10/abc.jpg`) e o modelo usa `Read` para vê-la. A pasta entra via `--add-dir`.
- **Saída:** parse do JSON. Campos esperados: `result`, `is_error`, `session_id`, `usage`, `total_cost_usd`, `num_turns`. Trate como opcionais e logue o que vier.
- **Autenticação:** variável `CLAUDE_CODE_OAUTH_TOKEN` (de `claude setup-token`) no ambiente do serviço. Ver DEPLOY.md.

### 5.2 Prompt do turno (montado pelo `ContextBuilder`)

```
<now>2026-10-13T20:41:00-03:00 (terça) — dia contábil 2026-10-13</now>
<today_snapshot>
kcal 1.240/— · proteína 98/150 g · treino: upper B registrado 18:10 · passos 6.420/10.000 · sono 6h40
</today_snapshot>
<open_session>upper B iniciado 18:10 — 3 exercícios, 10 séries</open_session>
<coach_notes>   (Fase 8b: preferências, eventos de vida próximos e observações recentes, com ids; ~1.500 caracteres)
- [3] preferência: prefere respostas sem análise de tendência
- [7] evento (pergunte agora): viagem a SP a trabalho até 31/10
</coach_notes>
<recent_turns>   (últimos 8 turnos, resumidos: mensagem do usuário + 1 linha do que foi registrado)
…
</recent_turns>
<quoted …>…</quoted>            (se houver)
<user_message>
[imagem: /abs/path/data/media/2026/10/abc.jpg]
almoço, frango foi 150g
</user_message>
```

Snapshot e histórico são compactos, com orçamento de até ~2.000 tokens. Para mais contexto, o modelo usa as tools de leitura.

### 5.3 Roteamento de modelo (economia de cota)

| Situação | Modelo (configurável) |
|---|---|
| Turno com imagem | `MODEL_VISION` (padrão `sonnet`) |
| Relatórios e perguntas analíticas | `MODEL_REPORT` (padrão `sonnet`) |
| Texto simples (logs, consultas) | `MODEL_FAST` (padrão `haiku`) |

A classificação é heurística no gateway: tem imagem? é relatório? contém palavras de análise como "por que", "compar", "tendência", "afeta", "relação"? Se `--fallback-model` estiver disponível, passe `sonnet` como fallback do `haiku`.

### 5.4 Interface plugável

```ts
interface Brain {
  run(input: { prompt: string; images: string[]; mode: 'turn' | 'report';
               toolScope: 'all' | 'read'; turnToken: string }): Promise<BrainResult>;
}
type BrainResult = { text: string; ok: boolean; usage?: unknown; costUsd?: number; raw?: unknown };
```

Implementações: `ClaudeCliBrain` (padrão), `AnthropicApiBrain` (API key, mesmas tools via `tools/registry`) e `GeminiBrain` (free tier, opcional). A escolha vem de `BRAIN_PROVIDER`.

## 6. Decisões (ADRs resumidos)

**ADR-1: Baileys em vez da WhatsApp Cloud API.**
A Cloud API cobra templates para mensagens fora da janela de 24 h (lembretes e relatórios proativos). Desde 15/01/2026, os termos da Meta também proíbem distribuir assistentes de IA de propósito geral pela Business API; um bot de escopo restrito seria provavelmente aceitável, mas adiciona risco de compliance e burocracia de setup. O Baileys é gratuito e sem janela, com risco de ban mitigado por número secundário, uso exclusivo pelo dono e baixo volume.
**Consequência:** o canal fica atrás da interface `Channel`, e um adaptador Cloud API ou Telegram pode substituí-lo.

**ADR-2: `claude -p` por turno em vez de Claude Code Channels.**
Channels é *research preview*. Canais custom exigem `--dangerously-load-development-channels`, que só funciona em sessão interativa e é ignorado com `-p`. Há relatos de 401 do token `setup-token` em sessões `--channels` de longa duração. Uma sessão única também acumula contexto indefinidamente. O `-p` stateless com contexto montado do banco é determinístico, fácil de testar e barato em tokens.

**ADR-3: MCP HTTP dentro do processo em vez de MCP stdio.**
Evita subir um processo Node a cada turno, compartilha a conexão SQLite e permite associar cada tool call ao turno (token no header), o que viabiliza `/desfazer` e correção por citação.

**ADR-4: SQLite.**
Um usuário, baixa concorrência, backup trivial. FTS5 para busca de alimentos e exercícios.

**ADR-5: matemática no código.**
Macros, agregações, e1RM, tendências e correlações são funções puras testadas. O LLM recebe números prontos e nunca soma.

**ADR-6: Health Connect via HC Webhook.**
O Health Connect fica só no aparelho, sem API em nuvem. O app HC Webhook (open source, na Play Store) envia JSON para um endpoint próprio com header customizado, e evita escrever app Android.

## 7. Segurança

- Allowlist do dono por pareamento, sem número fixo no código (§ DEPLOY.md, "Pareamento").
- O cérebro só tem as tools `fit` e o `Read`, limitado à pasta de mídia. Sem shell, sem web.
- Texto dentro de imagens (rótulos, prints) é tratado como **dado**, nunca como instrução. Isso está no system prompt.
- O servidor MCP escuta só em `127.0.0.1` e exige token de turno válido e ainda em execução (expira ao fim do turno).
- O endpoint de ingestão exige `X-Api-Key` com 32+ bytes aleatórios e tem rate limit (60 req/min).
- Segredos ficam em `/etc/impetus/env` (modo 600). O backup no Drive é criptografado (rclone crypt). A pasta `data/wa-auth/` **não** vai para o backup em nuvem.
- Supply chain: só o pacote oficial `baileys`. Nenhum pacote "anti-ban" de terceiros (em 2026 um deles foi pego exfiltrando sessões). Lockfile commitado, `npm audit` no CI local.

## 8. Riscos e mitigação

| Risco | Prob. | Impacto | Mitigação |
|---|---|---|---|
| Ban do número do bot | Média | Médio | Chip secundário; responder só ao dono; sem broadcast; adaptador Telegram pronto como plano B |
| Mudança na cobrança do `claude -p` | Média | Alto | `Brain` plugável; log de custo por turno; `/status` mostra o consumo |
| Expiração ou bug do token OAuth | Média | Alto | Alerta 30 dias antes; `claude auth status` no `/status`; runbook no DEPLOY.md |
| Quebra do Baileys por mudança no protocolo do WhatsApp | Média | Médio | Versão fixada; atualizar só com changelog lido; turnos ficam no banco e são reprocessados |
| Instância Oracle recuperada ou sem capacidade | Baixa (PAYG) | Alto | Backup diário; `deploy/setup-vm.sh` idempotente; restore em menos de 30 min |
| Erro de estimativa nutricional | Alta | Baixo | Protocolo em 2 etapas, TACO, priors, correção fácil, confiança exibida |
| HC Webhook para de sincronizar (Android mata o app) | Média | Baixo | Alerta de staleness 48 h; instruções para desativar otimização de bateria |
