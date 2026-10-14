# SPEC — Impetus

## 1. Visão

Um coach pessoal no WhatsApp que **registra** treino, alimentação e métricas corporais por mensagens naturais (texto, foto, ou ambos), **consulta** o histórico sob demanda e **gera relatórios com insights** cruzando treino, nutrição, sono e atividade.

Usuário único (o dono). Prioridades, nesta ordem: **praticidade de registro**, **custo zero**, **confiabilidade dos dados**, **qualidade dos insights**.

## 2. Objetivos

1. Registrar um treino completo em uma mensagem ou série a série, em linguagem livre.
2. Antes do treino, consultar as cargas da última sessão da mesma rotina, com sugestão de progressão.
3. Registrar refeições por texto, foto ou ambos. Texto e foto se complementam. Sem porção informada, estimar pela foto.
4. Importar automaticamente passos, sono, frequência cardíaca, peso e exercícios do relógio (Redmi Watch 5 Lite via Mi Fitness → Health Connect).
5. Relatórios diário, semanal e mensal, além de relatórios sob demanda, com insights acionáveis e baseados em evidência.
6. Corrigir qualquer registro com uma resposta curta e desfazer o último registro.
7. Rodar 24/7 numa VPS gratuita, sem o PC ligado.

## 3. Não-objetivos

- Multiusuário, cadastro, autenticação de terceiros.
- App mobile ou web completo. O WhatsApp é a interface; um dashboard web somente-leitura é opcional (Fase 7).
- Precisão nutricional de laboratório.
- Prescrição médica ou nutricional. O bot sugere e informa, não prescreve.
- Integração com Hevy ou outros apps pagos.

## 4. Princípios de produto

- **Registrar primeiro, perguntar depois.** Toda mensagem válida gera um registro imediato com a melhor estimativa. Perguntas de esclarecimento são raras (no máximo uma por refeição) e nunca bloqueiam o registro.
- **Correção barata.** Cada resposta do bot que cria registros é "citável": responder a ela com "frango foi 150g" corrige o item certo.
- **Respostas curtas.** Mensagens de confirmação cabem em uma tela de celular. Relatórios ficam em até ~1.200 caracteres de texto, com gráfico opcional.
- **Números vêm do código.** O LLM interpreta e escreve; somas, macros, tendências e e1RM são calculados pelo backend.
- **Transparência da estimativa.** Itens estimados por foto são marcados (`~`) e exibem a confiança.
- **Nenhuma meta presumida.** Metas (kcal, proteína, passos, sono, treinos/semana) são definidas pelo usuário via chat. Sem meta definida, os relatórios mostram os valores sem medir aderência.

## 5. Domínios e capacidades

### 5.1 Treino
- Log livre: `"upper B: supino inclinado halter 3x10 30kg, remada curvada 4x8 60kg"`.
- Log série a série durante o treino: `"supino 30kg 10 10 9"` agrega na sessão aberta (sessão aberta = última atividade há menos de 3 h).
- Formatos aceitos: `3x10 30kg`, `30kg 10/10/9`, `30x10, 30x10, 32x8`, `RPE 8`, `RIR 2`, `aquecimento 20kg 12`, `drop`, `até a falha`.
- Rotinas nomeadas ("upper A", "lower B") com lista de exercícios e faixa de reps, definidas por chat.
- Consulta: `"o que fiz no último upper B?"` ou `/treino upper B`, com cargas por exercício e sugestão de alvo (progressão dupla, ver REPORTS.md §2.4).
- PRs automáticos (carga máxima e e1RM) anunciados ao registrar.
- Cardio: `"30 min esteira"`, `"corri 5 km em 28 min"`. Sessões do relógio entram via Health Connect.
- Normalização de nomes: aliases em PT-BR ("sup inc", "supino inclinado") mapeiam para um exercício canônico.

### 5.2 Nutrição
- Texto, foto, ou foto + legenda. Foto e texto enviados separadamente em até ~20 s viram uma refeição só.
- Estimativa em duas etapas, aterrada na TACO, usando priors pessoais (ver NUTRITION.md).
- Totais diários de kcal, proteína, carboidratos, gordura e fibra.
- Alimentos personalizados ("meu whey: 1 scoop 30 g = 24 g prot").
- Código de barras: foto da embalagem ou número EAN via Open Food Facts.
- Foto de tabela nutricional cria alimento personalizado por 100 g.

### 5.3 Corpo e saúde
- Peso manual (`/peso 74,2` ou "pesei 74.2") e via Health Connect (balança compatível).
- Importação automática: passos, sono (duração e estágios), FC de repouso, FC, calorias ativas, exercícios.
- Tendência de peso por média móvel e taxa semanal.

### 5.4 Relatórios e insights
- Diário (opcional, 21:30): resumo do dia com pendências (ex.: faltam 40 g de proteína).
- Semanal (domingo, 20:00): treino, nutrição, corpo, atividade, sono e 3 insights.
- Mensal (dia 1, 09:00): tendências e progressão de força.
- Sob demanda: `/relatorio semana`, `/relatorio mes`, ou perguntas livres ("meu sono afeta meu supino?").
- Insights gerados por detectores determinísticos com evidência e tamanho de amostra. O LLM escolhe e redige (REPORTS.md).

### 5.5 Operação
- `/status`: conexão do WhatsApp, último sync de saúde, último backup, uso do LLM no dia.
- `/desfazer`: reverte o último registro.
- `/ajuda`: lista de comandos e exemplos.
- Alertas proativos de falha: sync de saúde parado há mais de 48 h, backup falhou, token do Claude expirando em até 30 dias.

## 6. Comandos determinísticos (sem LLM)

Comandos com `/` são tratados pelo gateway sem chamar o LLM, para economizar cota e responder na hora.

| Comando | Ação |
|---|---|
| `/ajuda` | Lista comandos e exemplos de mensagens livres |
| `/hoje` | Resumo do dia: refeições, macros vs. meta, treino, passos, sono |
| `/treino <rotina>` | Última sessão da rotina + alvos sugeridos |
| `/ultimo <exercício>` | Últimas 3 sessões do exercício |
| `/peso <valor>` | Registra peso |
| `/meta <chave> <valor>` | Define meta (`kcal`, `proteina`, `passos`, `sono`, `treinos`, `ritmo_peso`) |
| `/metas` | Mostra metas atuais |
| `/desfazer` | Desfaz o último turno que criou ou alterou registros |
| `/relatorio [dia\|semana\|mes]` | Gera relatório (usa LLM para a narrativa) |
| `/status` | Saúde do sistema |
| `/pausar` / `/retomar` | Pausa ou retoma mensagens proativas |

Mensagens sem `/` vão para o cérebro (LLM).

## 7. Conversas de exemplo

> Formato ilustrativo. Os números dos exemplos são fictícios.

**Log de treino completo**
```
Você: upper B: supino inclinado halter 3x10 30kg, remada curvada 4x8 60kg, elevação lateral 3x15 10kg
Bot:  ✅ Upper B registrado (3 exercícios, 10 séries)
      • Supino inclinado halter 30kg 3×10 (+2kg vs. último) 🏆 PR
      • Remada curvada 60kg 4×8 (=)
      • Elevação lateral 10kg 3×15 (=)
```

**Antes do treino**
```
Você: /treino upper B
Bot:  📋 Último upper B (08/10)
      • Supino inclinado halter: 28kg 10/10/9 → alvo hoje: 28kg 3×10
      • Remada curvada: 60kg 8/8/8/8 → alvo: 62,5kg 4×8
      • Elevação lateral: 10kg 15/15/13 → alvo: 10kg 3×15
```

**Foto + legenda**
```
Você: [foto do prato] almoço, frango foi 150g
Bot:  🍽️ Almoço registrado — ~575 kcal | 57g P | 55g C | 14g G
      • Frango grelhado 150g (informado)
      • ~Arroz branco 140g (120–170)
      • ~Feijão carioca 100g (80–130)
      • ~Óleo de preparo 8g (estimado)
      • ~Salada de alface e tomate 60g
      Confiança: média. Corrija respondendo esta mensagem, ex.: "arroz 100g".
```

**Só foto, item ambíguo de alto impacto**
```
Você: [foto]
Bot:  🍽️ Registrado — ~820 kcal | 38g P (estimativa)
      • ~Bife (contrafilé?) 160g …
      ❓ A carne é contrafilé ou patinho? Muda ~120 kcal.
Você: patinho
Bot:  ✏️ Atualizado: ~705 kcal | 41g P
```

**Correção por citação**
```
Você: (respondendo ao registro do almoço) arroz foi 100g
Bot:  ✏️ Almoço: arroz 140g → 100g. Novo total ~524 kcal.
```

**Consulta livre**
```
Você: quanto de proteína falta hoje?
Bot:  Hoje: 98g de 150g → faltam 52g. Ex.: 200g de frango ou 2 scoops de whey.
```

**Pergunta analítica**
```
Você: dormir pouco afeta meu treino?
Bot:  Nas últimas 8 semanas (19 sessões com dado de sono): após noites <6h, seu
      desempenho relativo nos compostos foi ~3% menor (n=6 vs. 13). Amostra pequena —
      é associação, não prova. Vale observar mais 4 semanas.
```

## 8. Requisitos não-funcionais

| Requisito | Alvo |
|---|---|
| Latência de comando `/` | < 2 s |
| Latência de mensagem livre (texto) | < 25 s (p90) |
| Latência de refeição com foto | < 45 s (p90) |
| Indicador de processamento | Reação 👀 na mensagem e "digitando…" enquanto o LLM roda |
| Disponibilidade | Reinício automático (systemd); reconexão automática do WhatsApp |
| Perda de dados | No máximo 24 h (backup diário) |
| Memória do processo | < 400 MB RSS (para caber até numa E2.1.Micro com swap) |
| Privacidade | Dados só na VPS e no backup criptografado; nenhum terceiro além do LLM |
| Fuso | America/Sao_Paulo. Dia contábil vira às 04:00 (refeição de madrugada conta no dia anterior) |

## 9. Critérios de sucesso (após 4 semanas de uso)

- Mais de 90% dos treinos registrados sem precisar corrigir o parse.
- Registro de refeição em menos de 15 s de esforço do usuário.
- Relatório semanal com ao menos 1 insight acionável por semana considerado útil pelo usuário.
- Nenhuma perda de dados.
