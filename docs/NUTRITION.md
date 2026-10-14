# NUTRITION — Protocolo de estimativa de refeições

## 1. Por que um protocolo

- Em estudo de 2025 com 52 fotos padronizadas, ChatGPT e Claude tiveram **erro médio de ~36–37% no peso e ~36% na energia**, e o erro de proteína passou de 60% em todos os modelos. O erro cresce com porções maiores.
- Separar **"o que tem no prato"** de **"como isso vira nutrientes"** (decomposição em duas etapas) melhora a confiabilidade das estimativas por LLM multimodal (MetaFood/CVPR 2025).
- Dar ao modelo **contexto estruturado** (cardápio, tabela de composição) reduz erros; sem aterramento, os erros são grandes (estudo em refeitório universitário finlandês).
- A maior fonte de erro é a **porção**. Gorduras de preparo (óleo, manteiga) são invisíveis na foto.

**Consequência de design:** o LLM identifica itens e estima gramas com intervalo. A **tabela (TACO)** fornece nutrientes por 100 g, o **código** faz as contas, o **texto do usuário** e os **priors pessoais** substituem estimativas visuais, e a **correção** do usuário alimenta os priors.

## 2. Entradas possíveis

| Caso | Exemplo | Estratégia |
|---|---|---|
| Só texto, com quantidades | "2 ovos mexidos e 2 fatias de pão integral" | Unidades → gramas via `get_portions`; `origin=text_estimate` ou `user_stated` se em gramas |
| Só texto, vago | "comi um prato de arroz, feijão e bife" | Priors pessoais → medidas caseiras IBGE → porção padrão; confiança `medium` ou `low` |
| Foto + legenda com quantidades | foto + "frango 150g" | Legenda manda nos itens citados; a foto completa o resto |
| Foto + legenda sem quantidades | foto + "almoço no RU" | A legenda resolve identidade e contexto; a foto estima porções |
| Só foto | — | Estimativa visual completa + priors |
| Foto de rótulo ou tabela nutricional | foto do verso da embalagem | Ler o rótulo → `create_custom_food(per_portion)`; perguntar a quantidade consumida, se não informada |
| Código de barras | foto ou número EAN | `lookup_barcode` |

Foto e texto enviados em mensagens separadas chegam juntos pelo debounce (ARCHITECTURE.md §4.2).

## 3. Algoritmo (o cérebro segue estes passos; está no system prompt)

**Passo 1 — Ler o texto.** Extrair itens citados, quantidades explícitas (g, ml, unidades, medidas caseiras), marcas, modo de preparo, tipo de refeição e horário ("isso foi ontem à noite"). Quantidade explícita em gramas vira `origin='user_stated'`, `confidence='high'`.

**Passo 2 — Analisar a foto (se houver).** Usar `Read` na imagem e listar, para cada componente visível:
- identidade provável e alternativas (ex.: "bife — contrafilé ou alcatra"),
- modo de preparo aparente,
- gramas estimadas com intervalo (`low`–`high`), usando pistas de escala (prato, talheres, copo, mão),
- itens parcialmente ocultos ou empilhados.

**Passo 3 — Fundir texto e foto.**
- Quantidade informada no texto **substitui** a estimativa visual do mesmo item.
- Identidade informada no texto **substitui** a da foto ("é patinho").
- Itens só na foto entram como `photo_estimate`.
- Itens só no texto entram mesmo sem aparecer na foto (ex.: "tomei um suco também").
- Conflitos ficam registrados em `assumptions`.

**Passo 4 — Priors pessoais.** Chamar `get_food_priors` com os rótulos. Se houver prior com `n ≥ 3` e a foto for compatível com a faixa `p25–p75`, usar a mediana do prior (`origin='prior'`). Se a foto indicar claramente uma porção diferente, manter a visual e citar o prior em `assumptions`.

**Passo 5 — Aterrar na tabela.** Para cada item, chamar `search_foods` e escolher o alimento cujo **estado** bate com o modo de preparo: cozido, grelhado ou frito para pratos prontos; cru só se for consumido cru. Sem correspondência razoável, usar o mais próximo e anotar em `assumptions`. Para pratos compostos (feijoada, strogonoff, lasanha), preferir o prato pronto se existir na TACO; senão, decompor nos ingredientes principais.

**Passo 6 — Gorduras ocultas.** Se houver preparo que costuma levar óleo ou manteiga (refogados, arroz, feijão temperado, frituras, ovos mexidos), adicionar um item separado de óleo ou manteiga com `confidence='low'` e intervalo, ou registrar em `assumptions` quando a TACO já considerar o preparo. O item separado deixa a premissa visível e fácil de remover pelo usuário.

**Passo 7 — Registrar.** Chamar `log_meal` com todos os itens, intervalos, origens, confiança e premissas. **Nunca calcular macros no texto**: usar os números devolvidos pela tool.

**Passo 8 — Responder.** Formato compacto (abaixo). Itens estimados levam `~`, com intervalo entre parênteses quando a confiança for `medium` ou `low`.

**Passo 9 — Perguntar, só se valer a pena.** No máximo **uma** pergunta por refeição, e somente se as duas condições forem verdadeiras:
1. um item com confiança `low` responde por **≥ 30% da kcal** ou **≥ 40% da proteína** da refeição, e
2. a resposta muda o total em **≥ 15%** ou define a identidade do item.

A pergunta vai em `pending_question`. A resposta do usuário chega como novo turno com o contexto da refeição e vira `update_meal_item` + `update_meal(clear_pending_question)`.

## 4. Formato da resposta

```
🍽️ {Tipo} registrado — {kcal} kcal | {P}g P | {C}g C | {G}g G
• {Item informado} {g}g (informado)
• ~{Item estimado} {g}g ({low}–{high})
• ~Óleo de preparo {g}g (estimado)
Hoje: {kcal_dia} kcal · {P_dia}/{meta}g proteína
Confiança: {alta|média|baixa}. Corrija respondendo esta mensagem.
❓ {pergunta, se houver}
```

- Até 8 itens. Acima disso, agrupar itens pequenos ("~Salada mista 80 g").
- Arredondamento: kcal ao inteiro, macros ao inteiro, gramas a múltiplos de 5 quando estimadas.
- Sem meta definida, omitir "/{meta}".

## 5. Correções e aprendizado

- Mensagens como "arroz foi 100g", "tira o óleo", "não tinha feijão" ou "era patinho" viram `update_meal_item` no item correto (via citação ou, sem citação, na refeição mais recente do dia com item compatível).
- Toda correção grava em `meal_corrections` e muda a origem do item para `corrected`, que passa a alimentar `v_food_priors`.
- **Viés sistemático:** se, em 14 dias, o usuário corrigir para baixo uma mesma categoria (ex.: arroz) em mais de 60% das vezes, o relatório semanal sinaliza ("suas fotos de arroz têm sido superestimadas ~20%") e o `ContextBuilder` passa a incluir essa calibração no prompt das próximas refeições com o item.

## 6. Dicas ao usuário (texto do `/ajuda`)

- Foto de cima, prato inteiro, com garfo ou mão no enquadramento como referência de escala.
- Informe o peso das fontes de proteína quando souber; é o que mais melhora a precisão.
- Pratos que você repete muito: corrija as primeiras vezes e o bot aprende a sua porção.

## 7. Limites que o bot deve declarar

- Estimativas por foto servem para **tendência**, não para medida exata.
- Molhos, óleo e recheios escondidos são as maiores incertezas.
- O bot **não** dá orientação clínica (doenças, alergias, transtornos alimentares) e sugere procurar um profissional quando o assunto surgir.
