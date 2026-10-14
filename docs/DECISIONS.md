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

## Pendentes (decidir na fase indicada)

- **Fase 1 — Retry do turno pode duplicar registros.** Se a tentativa 1 gravou e depois falhou, a tentativa 2
  grava de novo. Proposta: antes de cada retry ou reprocessamento, desfazer as escritas do `audit_log` daquela
  tentativa.
- **Fase 1 — Flags do `claude -p`.** O `--max-turns` não aparece no `--help` da 2.1.224, e o `--system-prompt-file`
  só aparece citado na descrição do `--bare`. Conferir ao implementar o `ClaudeCliBrain`.
- **Fase 1 — `Read` sem restrição de caminho.** A regra `"Read"` libera qualquer arquivo, inclusive `data/wa-auth`.
  Proposta: `Read(<mediaDir>/**)`.
- **Fase 1 — Token do MCP em `ps`.** O `--mcp-config` inline expõe o token na linha de comando. Proposta: arquivo
  temporário com permissão 600.
- **Fase 1 — Chaves de meta.** `/meta` (`proteina`, `ritmo_peso`), `set_goal` (`protein_g`, `weight_rate_kg_wk`,
  `weight_target_kg`) e `settings` (`goal.*`) não batem. Proposta: chaves canônicas = as do `set_goal`, com
  `goal.<chave>` em `settings`, e os nomes do `/meta` em PT-BR como apelidos.
- **Fase 1/3 — Latência e `--max-turns 15` em refeições com foto.** Proposta: `search_foods` e `get_portions`
  aceitarem várias consultas numa chamada.
- **Fase 1 — Refeição só de texto no `haiku`.** Avaliar nos evals da Fase 3 se o modelo rápido segue o protocolo.
- **Fase 3 — Confiança agregada da refeição.** O DATA_MODEL fala em "pior item ponderado por kcal" e o TOOLS em
  "ponderada por kcal". É preciso uma fórmula única antes de implementar.
- **Fase 3 — `query_sql` não consegue respeitar o timeout de 2 s em processo.** O better-sqlite3 é síncrono e não
  tem *interrupt*. Proposta: rodar a query num `worker_thread` e encerrar o worker no timeout. A tool não está
  atribuída a nenhuma fase.
- **Fase 5 — Relatório semanal no domingo às 20:00** deixa o jantar de domingo de fora. Alternativas: segunda de
  manhã, ou tratar domingo como dia parcial.
- **Fase 6 — RSS < 400 MB** não considera o processo `claude` (≈300 MB por turno). O fallback E2.1.Micro (1 GB) é
  otimista.
