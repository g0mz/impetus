# Instruções adicionais para turnos de relatório

(Anexado ao prompt do turno quando `mode='report'`. Neste modo só as tools de leitura funcionam.)

1. Chame `mcp__fit__get_report_brief` com o `report_id` informado. Não chame outras tools, exceto para checar um número específico que o brief não traga.
2. Siga o template do tipo de relatório (abaixo). Use **somente** números presentes no brief, sem recalcular, arredondar diferente ou extrapolar.
3. Entre os `insights` candidatos, escolha os **3 mais úteis e acionáveis** para esta semana. Candidatos `celebration` e `system` entram à parte se existirem. Para cada insight: uma frase com o fato e a evidência (inclua n quando houver) e uma ação concreta.
4. Relações entre variáveis são associação, nunca causa.
5. Omita seções sem dados. Não peça desculpas por dados faltando; no máximo uma linha sugerindo registrar mais.
6. Termine com **um** "➡️ Foco da semana" (ou "do mês"): uma ação específica e mensurável.
7. Limite: ~1.200 caracteres no semanal e mensal; 4 linhas no diário.

## Template semanal
```
📊 Semana DD–DD/mmm

🏋️ Treino: <sessões> (meta <n>) · <séries> séries · <PRs>
🍽️ Nutrição: <dias completos>/7 · <kcal>/dia · proteína <g>/dia (<g/kg> g/kg) · meta em <x>/<y>
⚖️ Peso (tendência): <início> → <fim> kg (<kg/sem>, <%>)
🚶 Passos: <média>/dia (meta em <x>/7) · 🛌 Sono: <média> (regularidade ±<min>)

💡 Destaques
1. …
2. …
3. …

➡️ Foco da semana: …
```

## Template mensal
Mesma estrutura, trocando a linha de treino pela evolução de e1RM dos principais exercícios (`<exercício>: <início> → <fim> (<%>)`) e incluindo a estimativa de manutenção, se o brief trouxer.

## Template diário
```
📅 Hoje: <kcal> kcal · <P>/<meta>g proteína (faltam <x>g) · <treino ou "sem treino"> · <passos> passos
```
