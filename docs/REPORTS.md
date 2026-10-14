# REPORTS — Métricas, insights e relatórios

Todas as métricas são **funções puras** em `src/domain/metrics/`, com testes unitários e fixtures. O LLM só redige a partir do `ReportBrief`.

## 1. Agenda

| Job | Quando (America/Sao_Paulo) | Condição |
|---|---|---|
| Relatório diário | 21:30 | Só se `report.daily=true` e houver ao menos 1 registro no dia |
| Relatório semanal | Domingo 20:00 | Semana seg–dom corrente |
| Relatório mensal | Dia 1, 09:00 | Mês anterior |
| Alerta: sync de saúde parado | A cada 6 h | Último `health_raw` há mais de 48 h (1 alerta por ocorrência) |
| Alerta: token Claude | Diário 10:00 | Faltam 30, 7 ou 1 dia para `CLAUDE_TOKEN_EXPIRES_AT` |
| Reprocessar turnos `failed`/`deferred` | A cada 10 min / hora cheia | — |
| Backup | 03:30 | — |

`/pausar` suspende as mensagens proativas (relatórios e alertas não críticos). Backup e alertas críticos continuam.

## 2. Métricas e fórmulas

### 2.1 Força
- **e1RM (Epley):** `e1rm = w × (1 + reps/30)`, só para séries `work` com `reps ≤ 12` e `w > 0`. O peso efetivo depende de `load_kind`: `per_hand` → ×2; `bodyweight_plus` → + peso corporal da tendência.
- **Melhor e1RM da sessão** por exercício = máximo entre as séries.
- **PR:** carga máxima histórica, e1RM máximo histórico, ou mais reps com a mesma carga.
- **Estagnação:** sem novo melhor e1RM nas últimas **4 sessões** do exercício, e ao menos 4 sessões em 21+ dias.
- **Índice de desempenho da sessão:** média, sobre os compostos da sessão, de `e1rm_sessão / mediana(e1rm das 4 sessões anteriores) − 1`. Usado em correlações.

### 2.2 Volume
- **Séries duras por músculo/semana:** séries `work` e `failure` (não `warmup`). Músculo primário conta 1,0; secundário, 0,5.
- **Tonelagem:** Σ (peso efetivo × reps) das séries `work`.
- **Equilíbrio:** razão de séries `push:pull` (chest+front_delts+triceps vs. lats+upper_back+rear_delts+biceps) e `quads:hamstrings+glutes`.
- **Frequência:** sessões por semana; dias de treino vs. `goal.training_days`.

### 2.3 Corpo
- **Tendência de peso:** média exponencial com α = 0,1 sobre pesagens diárias (dias sem pesagem não entram). Mostrar tendência, não o valor bruto.
- **Taxa semanal:** inclinação da regressão linear da tendência nos últimos 14–28 dias, em kg/semana e %PC/semana. Exige ≥ 8 pesagens.
- **Estimativa de manutenção (TDEE adaptativo):** `tdee ≈ kcal_média − (Δtendência_kg × 7.700 / dias)`. Exige ≥ 14 dias com registro "completo" (§2.5) em ≥ 80% dos dias e ≥ 8 pesagens. 7.700 kcal/kg é uma aproximação; o relatório deve chamar o resultado de "estimativa".

### 2.4 Regra de progressão (`get_next_targets`)
Progressão dupla, por exercício, com a faixa de reps da rotina (padrão 8–12 se não definida):
1. **increase:** todas as séries `work` da última sessão atingiram `rep_max` (com RPE ≤ 9, se registrado). Alvo: carga + `increment_kg` (padrão 2,5 kg barra/máquina, 2 kg halter `per_hand`) na base da faixa.
2. **hold:** dentro da faixa. Alvo: mesma carga, +1 rep na série mais fraca.
3. **deload:** queda de e1RM > 5% em 2 sessões seguidas, ou estagnação + sono médio < meta. Alvo: −10% de carga, mesmas reps.
4. **first_time:** sem histórico; sem alvo, só "registre a carga de referência".

### 2.5 Nutrição
- **Diário:** Σ kcal, proteína, carboidratos, gordura e fibra por `local_date`.
- **Dia completo:** ≥ 3 refeições **ou** ≥ 70% da `goal.kcal`. Dias incompletos ficam fora das médias de ingestão e da estimativa de TDEE.
- **Aderência à proteína:** dias completos com proteína ≥ 90% da meta / dias completos.
- **Proteína relativa:** g/kg = proteína média ÷ tendência de peso.
- **Qualidade do registro:** % kcal de itens `user_stated`/`corrected`/`label` vs. `photo_estimate`/`text_estimate`.

### 2.6 Atividade e sono
- **Passos:** média, mediana e dias ≥ meta.
- **Sono:** duração média; **regularidade** = desvio-padrão do ponto médio do sono (min); dias abaixo da meta.
- **FC de repouso:** tendência de 14 dias. Alta sustentada de ≥ 5 bpm vs. a média de 28 dias é sinal de fadiga ou doença, e só é **mencionada**, sem diagnóstico.

### 2.7 Relações entre domínios
- **Sono × desempenho:** Spearman entre o sono da noite anterior e o índice de desempenho da sessão. Exige n ≥ 8 sessões com sono; reporta ρ, n e diferença média entre noites < meta e ≥ meta.
- **Proteína × progressão:** aderência à proteína nas semanas com vs. sem PRs (descritivo).
- **Passos/kcal × taxa de peso:** descritivo, para explicar desvios da taxa planejada.

**Regra de linguagem:** relações são "associação", com n explícito. Nunca afirmar causa. Com n abaixo do mínimo, a métrica retorna `insufficient_data` e não vira insight.

## 3. Detectores de insight

Cada detector é uma função `(ctx) => InsightCandidate | null`:

```ts
type InsightCandidate = {
  id: string;                    // 'stagnation:supino_inclinado_halter'
  domain: 'training'|'nutrition'|'body'|'activity'|'sleep'|'cross'|'system';
  severity: 'info'|'suggestion'|'warning'|'celebration';
  title: string;                 // curto, em PT-BR
  evidence: Record<string, number|string>;   // números que sustentam
  n?: number;
  action?: string;               // sugestão concreta e conservadora
  score: number;                 // relevância 0–1 (heurística)
};
```

| Detector | Dispara quando | Ação sugerida |
|---|---|---|
| `pr_celebration` | PR na semana | Comemorar (lista curta) |
| `stagnation` | §2.1 | Variar faixa de reps, revisar sono e proteína, ou deload |
| `volume_imbalance` | push:pull fora de 0,7–1,4 ou músculo com 0 séries na semana tendo histórico | Ajustar a rotina |
| `volume_drop` | séries semanais −30% vs. média de 4 semanas | Checar motivo (viagem, cansaço) |
| `protein_gap` | aderência < 60% (n ≥ 4 dias completos) | Fonte prática de proteína no horário com déficit |
| `weight_rate_off` | taxa fora de ±0,25 kg/sem da `goal.weight_rate_kg_wk` | Ajustar ±150–250 kcal/dia, com base no TDEE estimado |
| `maintenance_update` | nova estimativa de TDEE difere > 150 kcal da anterior | Informar a nova estimativa |
| `logging_gaps` | < 4 dias completos na semana | Lembrete leve; sugerir foto rápida |
| `photo_bias` | NUTRITION.md §5 | Informar a calibração |
| `sleep_short` | média < meta − 30 min ou regularidade > 60 min | Higiene do sono, horário fixo |
| `sleep_performance_link` | §2.7 com n ≥ 8 e efeito ≥ 3% | Mostrar a associação com n |
| `steps_below` | média < 80% da meta | Sugestão concreta (ex.: caminhada pós-almoço) |
| `rhr_elevated` | §2.6 | Sugerir dia mais leve; sem diagnóstico |
| `hc_stale` | sem dados de saúde há > 48 h | Instruções de bateria do app |

Seleção: o código ordena por `score` (severidade × magnitude × confiança no n) e manda os **top 6** ao LLM, que escolhe **3**. Celebração e alerta de sistema não contam no limite.

## 4. `ReportBrief` (entrada do LLM)

```ts
type ReportBrief = {
  kind: 'daily'|'weekly'|'monthly'|'adhoc';
  period: { start: string; end: string };
  goals: Record<string, number>;
  training: { sessions; work_sets; sets_by_muscle: Record<Muscle, number>; prs: {...}[];
              top_lifts: { exercise; e1rm_start; e1rm_end; delta_pct }[] };
  nutrition: { complete_days; kcal_avg; protein_avg; protein_g_per_kg; protein_adherence_pct; logging_quality_pct };
  body: { weight_trend_start; weight_trend_end; rate_kg_wk; rate_pct_bw_wk; maintenance_estimate? };
  activity: { steps_avg; steps_days_hit; cardio_min };
  sleep: { avg_min; regularity_min; days_below_goal };
  insights: InsightCandidate[];
  comparisons: { vs_previous_period: Record<string, string> };   // "+3%" etc., pré-formatados
};
```

## 5. Template do relatório semanal (alvo para o LLM)

```
📊 Semana 06–12/out

🏋️ Treino: 4 sessões (meta 4) · 62 séries · 2 PRs (supino inc. 30 kg×10, remada 62,5 kg×8)
🍽️ Nutrição: 6/7 dias completos · 1.880 kcal/dia · proteína 142 g/dia (1,9 g/kg) · meta batida em 4/6
⚖️ Peso (tendência): 74,6 → 74,2 kg (−0,4 kg/sem, −0,5%)
🚶 Passos: 9.100/dia (meta em 4/7) · 🛌 Sono: 6h52 (regularidade ±48 min)

💡 Destaques
1. …
2. …
3. …

➡️ Foco da semana: <1 ação concreta>
```

Limite de ~1.200 caracteres. Seções sem dados são omitidas. Números vêm **literalmente** do brief.

Mensal: mesma estrutura, com evolução de e1RM dos 4–6 principais exercícios, volume médio por músculo e estimativa de manutenção.

Diário (curto): calorias e proteína vs. meta, o que falta, treino feito ou não, passos. No máximo 4 linhas.

## 6. Fallback sem LLM

`renderReportFallback(brief)` gera o mesmo template com os 3 insights de maior `score`, usando o `title` e a `action` dos detectores. Testado por snapshot.

## 7. Gráficos (Fase 5b)

Semanal: (1) tendência de peso de 8 semanas com pesagens brutas como pontos; (2) séries por grupo muscular na semana (barras horizontais). Mensal: e1RM dos principais exercícios (linhas). Pipeline: spec Vega-Lite → `vega` SVG → `@resvg/resvg-js` PNG 1080 px de largura, tema escuro legível no celular. Enviados como imagem após o texto.
