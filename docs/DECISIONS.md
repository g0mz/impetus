# DECISIONS — Impetus

Registro de decisões que mudam ou completam as specs. Cada entrada diz o que mudou, por quê e onde.
Formato: **D-NNN — título** (data, fase, status).

## Decididas

### D-001 — Projeto renomeado para Impetus (2026-10-13, Fase 0, aprovada)
O app se chama **Impetus** (antes FitCoach). Nomes trocados em todo o kit: pacote npm `impetus`, usuário de
serviço `impetus`, `/etc/impetus/`, unit `impetus.service`, banco `impetus.db`, variável `IMPETUS_ANTHROPIC_API_KEY`.
O servidor MCP continua se chamando `fit` (tools `mcp__fit__*`), que é nome interno.

### D-002 — Kit na raiz do repositório (2026-10-13, Fase 0, aprovada)
O conteúdo de `impetus-spec-kit/` foi movido para a raiz do repositório `impetus`, como o README do kit pede.

### D-003 — Node 24 LTS em vez de Node 22; TypeScript nativo (2026-10-13, Fase 0, aprovada)
- O Node 22 sai de suporte em abril de 2027; o Node 24 é o LTS ativo. `engines: >=24 <25`, `.nvmrc = 24`.
- O Node 24 executa TypeScript por *type stripping*. Por isso o `tsx` foi removido: `npm run dev`, scripts e
  `db:*` rodam com `node arquivo.ts`. O build de produção continua com `tsc` → `dist/` (a unit do systemd não muda).
- Consequências no código: `erasableSyntaxOnly` (sem `enum`, `namespace` nem *parameter properties*),
  `verbatimModuleSyntax` (`import type` obrigatório) e imports relativos com extensão `.ts`
  (`rewriteRelativeImportExtensions` reescreve para `.js` no build).
- TypeScript fixado em **6.0.x**: o typescript-eslint 8.71 ainda não suporta o TS 7.
- ESLint 10 com *flat config* (`eslint.config.js`); `.eslintrc.cjs` está obsoleto.

### D-004 — cwd do cérebro fora do repositório (2026-10-13, Fase 0, aprovada)
O `claude -p` procura `CLAUDE.md` subindo a partir do cwd. Só o `--bare` desliga essa busca, segundo o
`claude --help` da versão 2.1.224, e o `--bare` não usa o token OAuth. Com cwd em `data/brain/` dentro do
repositório, o coach herdaria o `CLAUDE.md` de desenvolvimento.
- Nova variável `BRAIN_DIR` (padrão `~/.local/state/impetus/brain`). `loadConfig` **recusa** um `BRAIN_DIR` dentro
  do repositório.
- Na Fase 1, verificar `--setting-sources` (aceita `user,project,local`) para não carregar hooks, plugins nem
  memória do usuário do sistema, e registrar aqui o resultado.

### D-005 — FTS de exercícios com conteúdo próprio (2026-10-13, Fase 0, aprovada)
`exercises_fts` era *contentless* (`content=''`), o que não suporta `rebuild`, delete nem leitura das colunas.
Passa a guardar o próprio conteúdo (`name_pt`, `name_en`, `aliases`), com `tokenize="unicode61 remove_diacritics 2"`,
e é mantido pelo código (`syncExerciseFts` / `rebuildExerciseFts`), já que os apelidos vêm de outra tabela.

### D-006 — Triggers de sincronização do `foods_fts` (2026-10-13, Fase 0, aprovada)
`foods_fts` usa *external content* (`content='foods'`), que exige triggers. Foram criados `foods_ai`, `foods_ad`
e `foods_au` (este só para `name`/`brand`). O soft delete é filtrado no JOIN da busca.

### D-007 — Priors pessoais calculados no código (2026-10-13, Fase 0, aprovada)
A view `v_food_priors` foi removida. Ela comparava `datetime('now')` (`YYYY-MM-DD HH:MM:SS`) com ISO terminado em
`Z`, o que erra o limite em até 1 dia, e dependia do relógio, o que impede testes determinísticos. No lugar dela:
índice `meal_items(label_norm, created_at)`. Mediana, p25 e p75 com janela de 120 dias recebendo `now` como
parâmetro serão implementados em `domain/nutrition/priors.ts` (Fase 3).

### D-008 — Chave de idempotência do HC sem o valor (2026-10-13, Fase 0, aprovada)
`health_samples.external_key` passa de `type|start|end|value` para `type|start|end`. Com o valor na chave, um
reenvio do mesmo intervalo com valor atualizado (os passos crescem ao longo do dia) virava outra linha e era somado
duas vezes. A normalização (Fase 4) faz *upsert* do valor; foi criada a coluna `updated_at`.

### D-009 — Procedência em `food_portions` (2026-10-13, Fase 0, aprovada)
Foram criadas as colunas `food_name` (nome do alimento na fonte, quando `food_id` é NULL) e `source_ref`
(página do PDF, medida e referência do IBGE). As medidas do IBGE não apontam para ids da TACO, e ligar uma à
outra exigiria julgamento. Por isso entram com `food_id` NULL e o nome do IBGE, e o `get_portions` (Fase 3) busca
por texto.

### D-010 — Seeds idempotentes (2026-10-13, Fase 0, aprovada)
Foi criado `UNIQUE (source, source_id)` em `foods` e `exercises`. Os seeds fazem *upsert* e podem ser
re-executados sem duplicar nada. As medidas do IBGE são recarregadas (apaga e reinsere as de `source='ibge'`).

### D-011 — `is_prepared` dos alimentos da TACO (2026-10-13, Fase 0)
A TACO não tem campo de "pronto para consumo". A regra adotada é: categoria 13 ("Alimentos preparados") **ou**
preparo no nome (cozido, grelhado, frito, assado, refogado, ensopado, à milanesa, pronto, preparado). É uma
heurística usada só para filtrar a busca (`prepared`), e nenhum cálculo depende dela.

### D-012 — Exercícios do free-exercise-db sem tradução (2026-10-13, Fase 0)
`exercises.name_pt` é NOT NULL. Os 876 exercícios são importados e, enquanto não houver tradução, `name_pt`
recebe o nome em inglês. O CSV PT-BR (`seeds/exercises_ptbr.csv`) sobrescreve nome, apelidos, `load_kind`,
`increment_kg` e músculos dos exercícios comuns. A fonte só tem "shoulders"; o mapeamento para
`front/side/rear_delts` é heurístico (`domain/training/muscles.ts`) e vale só para os exercícios que o CSV não cobre.

### D-013 — Dados de seed versionados e conferidos (2026-10-13, Fase 0, aprovada)
- `seeds/vendor/` guarda os dados brutos (TACO via taco-api; free-exercise-db fixado no commit `f00c92c`), com
  `manifest.json` (sha256, fonte, licença). `npm run db:seed` **recusa** arquivo ausente ou alterado.
- A TACO foi conferida contra o PDF oficial da NEPA (sha256 `2002aec5…`, idêntico ao do repositório taco-api):
  213 linhas completas extraídas do PDF, com 2.343 valores comparados. As 198 linhas extraídas sem problema batem
  exatamente com o CSV. As 15 de uma página que o `pdftotext` embaralhou (ids 32–46) foram conferidas na imagem da
  página. Os 5 alimentos do teste estão em `tests/integration/seeds.test.ts`, com a página de cada um.
- **Lacuna conhecida:** 6 itens da TACO não têm energia na fonte (`*` = "em reavaliação"; `NA` no sal) e não entram:
  iogurte sabor abacaxi, leite desnatado UHT, **leite integral**, sal dietético, sal grosso e coco verde cru. O leite
  deve entrar como alimento personalizado (rótulo) ou via Open Food Facts.
- Medidas caseiras: 84 entradas da Tabela de Medidas Referidas (IBGE, POF 2008–2009, `liv50000.pdf`, sha256
  `317ace59…`). Cada linha foi extraída por coordenadas e só entrou se aparecesse literalmente no texto bruto da
  página (as divergentes foram relidas do texto bruto). Procedência por linha (`fonte_pagina` = página do PDF;
  `fonte_ref` = código do Quadro 3). Scripts em `scripts/provenance/`.
- Quando o IBGE usa a referência de outro alimento, isso fica visível na coluna `referencia` (ex.: feijão usa
  "Feijão branco cozido - concha média cheia"; o filé de frango grelhado usa "Frango frito - filé médio").

### D-014 — Retry de turno sem duplicar registros (2026-10-14, Fase 1, aprovada)
Antes de repetir um turno que falhou (retry imediato ou reprocessamento de `failed`/`deferred`), o turn-runner
desfaz as escritas daquela tentativa pelo `audit_log` (mesmo mecanismo do `/desfazer`) e gera um token novo.

### D-015 — `Read` restrito à pasta de mídia (2026-10-14, Fase 1, aprovada)
O cérebro recebe `Read(<mediaDir>/**)` em vez de `Read` liberado, para não ler `wa-auth`, o banco ou segredos.

### D-016 — Configuração MCP em arquivo temporário (2026-10-14, Fase 1, aprovada)
O `--mcp-config` aponta para um arquivo temporário (modo 600) criado por turno e apagado ao fim, para o token não
aparecer na linha de comando (`ps`).

### D-017 — Chaves de meta canônicas (2026-10-14, Fase 1, aprovada)
Chaves = as do `set_goal`: `kcal`, `protein_g`, `steps`, `sleep_h`, `training_days`, `weight_rate_kg_wk`,
`weight_target_kg`; guardadas em `settings` como `goal.<chave>`. O `/meta` aceita apelidos PT-BR: `proteina`,
`passos`, `sono`, `treinos`, `ritmo_peso`, `peso_alvo`.

### D-018 — Isolamento do coach: `--setting-sources ""` (2026-10-14, Fase 1, aprovada e medida)
Testado com o CLI 2.1.224 logado, com o `ClaudeCliBrain` real contra um MCP real (haiku, 2 chamadas por teste):
| Variante | Tokens de entrada | MCP | `CLAUDE.md` no cwd |
|---|---|---|---|
| sem `--strict-mcp-config` nem isolamento | ~99 mil | — | — |
| nenhum isolamento (com `--strict-mcp-config`) | 29,1 mil | funciona | **vaza** (respondeu "151 BANANA") |
| `--setting-sources ""` | 14,3 mil | funciona | bloqueado |
| `--safe-mode` | — | **quebra** ("a ferramenta get_goals não existe") | — |

- Decisão: `--setting-sources ""` (`BRAIN_ISOLATION=setting-sources`, padrão) + cwd fora do repositório (D-004),
  como defesa em camadas. O `--strict-mcp-config` corta os servidores MCP dos plugins do usuário (a maior parte do
  custo sem isolamento).
- Os ~7 mil tokens por chamada que sobram são o system prompt do coach e os schemas das tools.
- `--system-prompt-file` e `--max-turns` são aceitos e têm efeito, embora não apareçam no `--help`.
- D-015 conferido no Windows: `Read(//c/...)` abre imagem dentro de `data/media` e bloqueia arquivo fora dela.

### D-019 — `search_exercises` em lote (2026-10-14, Fase 1, aprovada)
`search_exercises` aceita `queries: string[]` (até 10) além de `query`, devolvendo os resultados por consulta, para
um treino com vários exercícios caber no `--max-turns`.

### D-020 — Baileys 7.0.0-rc14 fixado (2026-10-14, Fase 2)
A tag `latest` do pacote oficial `baileys` (WhiskeySockets) já é a 7.0.0-rc14; a 6.7.x virou `legacy`. Fixamos a
rc14 (suporte a LID: `remoteJidAlt`/`participantAlt`) com versão exata no lockfile. Atualizar só após ler o changelog.
Áudio é ignorado até a Fase 7 (transcrição). O pareamento grava todos os identificadores do remetente e aprende
novos (JID ↔ LID) quando chegam junto de um já conhecido.

### D-021 — Confiança agregada da refeição (2026-10-14, Fase 3)
Média das confianças dos itens ponderada pela kcal (alta = 1, média = 0,5, baixa = 0): ≥ 0,75 → alta,
≥ 0,4 → média, abaixo → baixa. Substitui as descrições divergentes do DATA_MODEL ("pior item") e do TOOLS.

### D-022 — Etapa `prepare` assíncrona nas tools (2026-10-14, Fase 3)
As transações do better-sqlite3 são síncronas. Tools que precisam de rede (`lookup_barcode` → Open Food Facts)
declaram `prepare(input, env)`, executada antes e fora da transação; o resultado chega ao handler em `ctx.prepared`.
Falha de rede vira `found: false` com dica para pedir foto da tabela nutricional. `fetch` é injetável nos testes.

### D-023 — Itens da refeição no `get_day_summary` e override escalável (2026-10-14, Fase 3)
Para corrigir sem citação ("arroz foi 100g"), o resumo do dia lista `item_id`, rótulo e gramas de cada refeição.
`macros_override` é guardado com a gramatura de referência (`per_grams`) e escala se a gramatura for corrigida.

### D-024 — Haiku nas refeições só de texto: mantido, com protocolo reforçado (2026-10-14, Fase 3)
Primeira rodada dos evals (haiku): o coach dividia "2 ovos" em dois itens marcados como `user_stated` e omitia a
gordura de preparo. O system prompt passou a exigir um item com o total e `text_estimate` para unidades, e item de
óleo/manteiga obrigatório (exceto quando o alimento da tabela já é o preparo com gordura). Após o ajuste, 9/9 casos
de texto passam com o haiku. Fotos continuam no `MODEL_VISION`.

### D-025 — Formato do HC Webhook conferido no código-fonte do app (2026-10-14, Fase 4; provisório até o payload real)
Sem payload real ainda, o mapeamento seguiu `docs/webhook.md` e o código do app (`SyncManager.kt`,
`HealthConnectManager.kt`), conferidos com as constantes do AndroidX:
- Estágio do sono = `stage.toString()` do AndroidX (inteiro como texto): 0 desconhecido, 1 acordado, 2 dormindo,
  3 fora da cama, 4 leve, 5 profundo, 6 REM, 7 acordado na cama. O payload de teste do app usa nomes ("deep");
  aceitamos os dois. Minutos de sono = soma dos estágios exceto acordado/fora da cama.
- Tipo de exercício = `EXERCISE_TYPE_*` como texto (56 corrida, 57 esteira, 70/81 musculação…); força vira cardio
  "musculação (relógio)" só como referência de duração.
- FC/HRV/SpO₂ podem vir como agregados de N minutos (`avg/min/max`): usamos `avg`.
- O JSON não traz id de registro: idempotência por `type|start|end` (D-008).
- Dia contábil: intervalos pelo ponto médio; sono pelo fim da sessão.
- Risco a validar com o payload real: passos agregados por dia somados a intervalos finos (contagem dupla).

### D-026 — Canal WhatsApp Cloud API (oficial) em vez de chip + Baileys (2026-10-14, antes de fechar a Fase 5)
O dono não quer manter um chip pré-pago só para o bot. Escolha: canal `whatsapp-cloud` (API oficial da Meta),
com Telegram como plano B se não der certo. O canal Baileys continua no código (`CHANNEL=whatsapp`).
Consequências e riscos:
- **Exige webhook HTTPS público**, o que contraria a regra "só 127.0.0.1". Mitigação: o servidor continua ouvindo em
  127.0.0.1 e é exposto **só** a rota do webhook via Cloudflare Tunnel; a assinatura `X-Hub-Signature-256` (HMAC com
  o app secret) é verificada antes de qualquer processamento; MCP e ingest seguem inacessíveis de fora.
- **Custo (a partir de 2026-10-01, a confirmar na tabela oficial da Meta):** mensagens de serviço (dentro da janela
  de 24 h) têm franquia mensal grátis (~1.000/número); fora da janela só com template pago (utility). Relatórios e
  alertas agendados fora da janela precisam de template + forma de pagamento.
- **Decisão do dono:** sem templates e sem forma de pagamento. O bot só fala dentro da janela de 24 h. Envios
  proativos (relatórios, alertas) fora da janela ficam pendentes e são entregues junto da próxima resposta; o dono
  pode pedir sob demanda (`/relatorio`).
- **Resultado (descartada no mesmo dia):** o envio do número de teste (+1 555) para o número brasileiro do dono
  falhou com `130497` ("Business account is restricted from messaging users in this country"). Remetente
  brasileiro exigiria um chip de novo, que é o que se queria evitar. Substituída pela D-027.

### D-027 — Telegram como canal principal (2026-10-14, antes de fechar a Fase 5)
Sem custo, sem chip, API oficial e sem exposição de rede: Bot API por *long polling* (`getUpdates`), sem webhook.
O adaptador previsto na Fase 7 foi antecipado. Implementação sem dependência nova (`fetch` nativo):
- Id externo = `<chat_id>:<message_id>` (o `message_id` só é único no chat); remetente = `tg:<user_id>`; o
  pareamento `PAREAR <código>` e a allowlist do gateway funcionam sem mudança.
- O offset só avança depois de processar cada update: após reinício o Telegram reentrega e o inbox deduplica.
- O token vai na URL da API; erros são reescritos sem a URL e sem `cause` para não vazar o token nos logs.
- Reação 👀 + "digitando…"; mensagens divididas em partes de até 4000 caracteres (limite 4096); fotos e
  documentos `image/*` passam pela mesma normalização de imagem.
- O Baileys continua disponível com `CHANNEL=whatsapp`.
- Número de teste da Meta (até 5 destinatários) é suficiente para um usuário; token permanente via *system user*.

### D-028 — WhatsApp (Baileys) no chip secundário volta a ser o canal principal (2026-10-14)
- O dono decidiu usar o chip pré-pago Claro secundário (recarga mínima R$ 15 a cada 30 dias). Substitui a D-027;
  Telegram fica como alternativa (`CHANNEL=telegram`).
- Pareamento por código exige navegador padrão (`Browsers.macOS('Chrome')`); nome customizado era recusado.
- `wa:link` grava e confere `creds.json` antes de sair (no Windows o `process.exit` deixou o arquivo com 0 bytes).
- Lembrete de recarga: `/recarga` + job `alert.sim_recharge` (crítico a partir de 25 dias).

### D-029 — Backup em TypeScript em vez de `scripts/backup.sh` (2026-10-14, Fase 6)
- `src/ops/backup.ts` usa a API de backup do better-sqlite3 (consistente com WAL, sem `sqlite3` CLI), gzip e
  retenção local; rclone só se `BACKUP_REMOTE` estiver definido. Roda igual no PC (Windows) e na VM e é testado
  com restore real (`tests/integration/ops.test.ts`). `npm run restore` confere `integrity_check`.

### D-030 — Mensagens de voz com whisper.cpp local (2026-10-14, Fase 7)
- Canal salva o áudio (OGG/Opus) → gateway transcreve (ffmpeg → WAV 16 kHz → `whisper-cli -l pt`) → o texto
  vai ao cérebro com o prefixo 🎤 (o system prompt avisa que pode haver erro de reconhecimento e pede para
  confirmar números improváveis). Sem rede, sem custo por uso; o áudio não sai da máquina.
- Modelo padrão `ggml-small-q5_1` (~190 MB): bom em PT-BR e viável em 2 OCPU A1. Trocável por `WHISPER_MODEL`.
- Um áudio por vez (CPU); limite `AUDIO_MAX_SECONDS` (180 s). Comandos falados não viram comando.
- Retry de turno falho reenvia a transcrição gravada, não o arquivo.
- `TRANSCRIBE=none` (padrão) responde pedindo texto.

### D-031 — Robustez da conversa após o primeiro uso real (2026-10-15)
Problemas vistos no treino de 14/10 e correções:
- **Contexto perdido:** `<recent_turns>` cortava a mensagem do usuário em 200 caracteres e omitia a resposta do
  coach. Agora os 2 turnos mais recentes vão quase inteiros (1.200/600 caracteres), com a resposta do coach e o
  que foi gravado; orçamento do contexto 12.000 caracteres.
- **"✅ registrado" sem gravar:** trava no turn-runner. Se a resposta afirma registro e o turno não tem escrita no
  `audit_log`, roda de novo (modelo forte) com `<system_check>`; se insistir, o usuário recebe um aviso explícito.
- **Registro longo no modelo rápido:** ≥ 3 linhas ou ≥ 8 números → `MODEL_VISION` (Sonnet).
- **Sem como corrigir treino:** tool `edit_workout` (horário, notas, carga/reps/tipo/exercício de séries, apagar),
  com `/desfazer`. `<open_session>` e `get_last_sessions` expõem `set_id`.
- **Hora sem fuso** ("2026-10-14T18:15") era lida no fuso do servidor (na VM, UTC): agora é hora local do usuário.
- **Exercícios duplicados** ("Extensora de perna" com "Cadeira extensora" no catálogo): busca relaxada (palavras
  significativas, sinônimos de academia como gêmeos → panturrilha) e `create_exercise` devolve CONFLICT com
  candidatos, salvo `confirm_new`.
- **Markdown de chat** (`**negrito**`, `#`) convertido para o formato do WhatsApp / texto puro no Telegram.
- **Cardio "velocidade 6":** `speed_kmh` na tool; distância calculada no código (regra 1).
- **Prompt:** não citar conta/e-mail/sistema; não pedir o que já foi dito; faixa de reps → menor valor; rampa
  ≤ 60% da maior carga → aquecimento; resumo com 📋; tools inexistentes (`get_metrics`, `query_sql`) removidas.
- **Operação:** cópia automática de `creds.json` (restaura se corromper), mídia de desconhecidos nem é baixada,
  entrada serial (ordem preservada com áudio), trava de instância única por `DATA_DIR`.
- Eval `workout_conversation` reproduz a conversa real; suíte 11/11 (3 pulados por falta de foto).

### D-032 — Chave `type|start` para tipos acumulados do HC (2026-10-16, Fase 4, aprovada)
O primeiro sync real (HC Webhook 1.9.22) confirmou o risco do D-025. Passos e calorias chegam como **um bloco por
dia, do início do dia até o instante do sync** (`03:00Z → agora`), e o fim muda a cada envio. Com a chave do D-008
(`type|start|end`), cada sync virava uma linha nova e o dia somava todas: 16.209 passos em vez de 4.060.
- Em `steps`, `active_kcal`, `total_kcal` e `distance`, a chave passa a ser `type|start`. O upsert substitui o
  valor e o `end_at`.
- O upsert só aplica se o `end_at` novo for ≥ ao gravado. Assim, um payload atrasado não regride o acumulado.
- Os demais tipos (FC, HRV, SpO2, sono) seguem com `type|start|end`.
- O botão "Test Webhook" manda dados fictícios com `test: true`: o ingest responde ok e não grava nada.

### D-033 — Tailscale `serve` para a ingestão do HC, em vez de HTTPS público (2026-10-17, Fase 4)
O ingest escuta só em 127.0.0.1 (ARCHITECTURE.md §9) e o celular precisa alcançá-lo. Entre as duas opções do
DEPLOY.md §6, ficou a A: `tailscale serve --bg --https=443 http://127.0.0.1:8787` na VM, celular na mesma tailnet.
- Nada é exposto na internet: a 8787 segue em loopback, a Security List da VCN e o iptables da imagem da OCI não
  foram tocados (nenhuma porta aberta além da 22). Quem atravessa é o proxy do Tailscale, pelo WireGuard.
- Custo: o celular precisa estar na tailnet no momento do sync (VPN sempre ativa). A opção B (Caddy + DuckDNS)
  dispensaria a VPN, mas abriria a 443 para a internet com um endpoint protegido só pela `X-Api-Key`.
- A `X-Api-Key` continua obrigatória: a tailnet é a primeira camada, não a única.

### D-034 — Cargas salvas na rotina e "fiz upper A" (2026-10-21)
Pedido do dono: deixar o treino predefinido e só dizer "estou fazendo upper A", mudando a carga só quando ela sobe ou cai.
- `routine_exercises` ganha `weight_kg` e `reps` (migration 002). Não criamos uma tabela de "cargas atuais": a rotina já
  é o lugar da prescrição, e o snapshot de undo da rotina cobre as duas colunas.
- Tool nova `log_routine`: monta as séries a partir do salvo (função pura `plannedSets`), aplica só os ajustes do dia
  e reaproveita a gravação do `log_workout` (sessão aberta, `vs_last`, PRs). Faltando dado salvo, devolve `VALIDATION`
  com o que perguntar, em vez de inventar carga (regra 1 e "sem dados inventados").
- **Regra de atualização:** a maior carga de trabalho do exercício no treino vira a carga salva quando difere dela (vale
  para subir e para descer). Reps e número de séries **não** mudam sozinhos: variam de sessão para sessão na progressão
  dupla; mudar o salvo é pedido explícito (`set_routine_loads`). "Só hoje" → `keep_loads: true`.
- A carga salva é o que o usuário faz, não o alvo da progressão: `get_next_targets` e `/treino` mostram as duas.
- Tudo entra no `/desfazer` (o `log_routine` audita a rotina com o snapshot anterior).
- **Sem carga conhecida** (nem salva nem em treino anterior): a pedido do dono, o treino é anotado mesmo assim, com séries
  e reps sem carga, e o coach avisa no início da resposta. Preferimos séries sem carga a uma sessão vazia porque dias de
  treino e séries por músculo vêm das séries. Para não gerar "+50kg" ou 🏆 falsos depois, num exercício que leva carga
  as séries sem carga ficam fora de `vs_last` e de PRs, e a carga de referência vem da última sessão **com** carga.
### D-035 — Camada de coach inspirada no my-fitness-claw (2026-10-21, Fase 8, aprovada)
O my-fitness-claw (Clawdino) guarda tudo em markdown e CSV: dados fracos, mas um coach forte. O Impetus tem o
inverso. A Fase 8 adota a camada de coach e mantém a de dados.
- **Adotado:** tom com exemplos e regras (número com significado, pessoa antes do dado, deslize sem compensação);
  resposta só com reação; memória da pessoa (preferências, observações, eventos datados); ajustes temporários do
  plano que mudam sessões e nunca metas; check-in diário que fica calado quando não há o que dizer; base de
  evidências lida sob demanda; simulação por personas.
- **Adaptado:** a memória vira as tabelas `coach_notes` e `plan_overrides`, escritas por tools (regra 2), em vez de
  arquivos editados pelo modelo. O check-in decide em código se envia; o LLM só redige. As evidências são reescritas
  em PT-BR com fontes conferidas (regra 10), não copiadas.
- **Recusado:** markdown e CSV como banco; níveis pupil/grinder/maxxer (com um usuário, o nível de detalhe é uma
  preferência em `coach_notes`); plano em PDF; instalação como plugin; Telegram sem BotFather.

### D-036 — Check-in da manhã decidido no código; relatório semanal fica no domingo (2026-10-21, Fase 8d)
- O código decide se o check-in sai (sessão planejada, noite < 6 h ou evento de vida vencendo). Dado faltando de
  ontem, sozinho, não gera mensagem: seria cobrança diária. Dia sem nada a dizer não chama o cérebro.
- O check-in usa `MODEL_REPORT`: sai uma vez por dia e o tom pesa mais que o custo.
- **Relatório semanal mantido no domingo 20:00** (pendência da Fase 5). Mudar para segunda exigiria separar o
  período do relatório agendado do `/relatorio semana` (que mostra a semana corrente). O jantar de domingo fica de
  fora do semanal, mas entra nas tendências da semana seguinte. Reavaliar depois de algumas semanas de check-in.

### D-037 — Base de evidências conferida, mas ainda sem revisão do dono (2026-10-21, Fase 8e)
- `runtime/evidence/` tem 8 arquivos (volume, intensidade, frequência, descanso, proteína, balanço energético,
  suplementos, mitos) com 19 fontes. Todo DOI foi conferido no Crossref e todo número no abstract (OpenAlex ou
  PubMed); a dose de creatina, no texto completo (PMC5469049).
- Ficaram de fora, por falta de fonte conferida: progressão de carga, deload, seleção de exercícios, adesão e sono.
  O prompt manda tratar esses temas como orientação geral, sem números.
- Commitado por pedido explícito do dono ("vá commitando tudo"), contra a regra de pausar para revisão de dados com
  julgamento. **Pendente: o dono revisar os 8 arquivos.**
- O caminho da pasta chega ao modelo como `<evidence_dir>` anexado pelo `claude-cli.ts`, com `--add-dir` e
  `Read(...)` liberado só para ela (o prompt do turno continua sem saber da CLI, regra 8).
- Efeito colateral visto nos evals: com o prompt mais longo, o Haiku passou a marcar unidade caseira como
  `user_stated`; a regra de origem virou o primeiro passo da nutrição, com exemplo.

### D-038 — Telegram vira o canal de produção; WhatsApp/Baileys fica como legado (2026-10-30)
- Motivo: o número usado no WhatsApp era um chip pré-pago (Claro) que precisava de renovação a cada 15 dias.
  Substitui D-028; D-026 (Cloud API) segue descartada.
- Produção: `CHANNEL=telegram`, definido no ambiente da VM (`/etc/impetus/env.app`), não no repositório. O default
  em `src/config.ts` continua `terminal` (desenvolvimento).
- O código do canal Baileys e `wa:link` ficam no repositório, sem uso. Remover é decisão futura.
- Docs atualizados: README, CLAUDE.md, SPEC, ARCHITECTURE (visão geral), DEPLOY (§5). Entradas históricas
  (D-020, D-026, D-028), CHANGELOG, TASKS e REFERENCES descrevem o que foi feito na época e não foram reescritos.

## Pendentes (decidir na fase indicada)

- **Fase 3 — `query_sql` não consegue respeitar o timeout de 2 s em processo.** O better-sqlite3 é síncrono e não
  tem *interrupt*. Proposta: rodar a query num `worker_thread` e encerrar o worker no timeout. A tool não está
  atribuída a nenhuma fase.
- **Fase 6 — RSS < 400 MB** não considera o processo `claude` (≈300 MB por turno). O fallback E2.1.Micro (1 GB) é
  otimista.
