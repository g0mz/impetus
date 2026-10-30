# Roteiro de teste manual — WhatsApp (LEGADO: canal abandonado, ver D-038)

Tudo o que não depende do WhatsApp real já é coberto por testes automáticos (parsing das mensagens, allowlist,
pareamento, debounce, fila, divisão de mensagens, normalização de imagens). Este roteiro cobre o resto.

## Preparação (uma vez)

1. Chip secundário com WhatsApp num celular (o "número do bot"). **Nunca o seu número principal.**
2. No PC (ou na VM), com o `.env` apontando `CHANNEL=whatsapp`:
   ```bash
   npm run wa:link -- --phone 55DDNNNNNNNNN
   ```
   No celular do bot: WhatsApp → Aparelhos conectados → Conectar com número de telefone → digite o código.
   Sem esse método: `npm run wa:link -- --qr` e escaneie.
3. Suba o app: `CHANNEL=whatsapp npm run dev` (logs no terminal). Procure a linha
   `Sem dono pareado. Do seu número pessoal, envie ao bot: PAREAR 123456`.
4. Do **seu número pessoal**, envie ao bot `PAREAR 123456` (o código do log). Resposta esperada: "✅ Pareado!".

## Cenários

| # | Ação no celular | Esperado |
|---|---|---|
| 1 | `meu upper B é: supino inclinado halter 3x8-12, remada curvada 4x6-10, elevação lateral 3x12-15` | 👀 na mensagem, "digitando…", rotina confirmada |
| 2 | `upper B: supino inclinado halter 3x10 30kg, remada curvada 4x8 60kg, elevação lateral 3x15 10kg` | 10 séries registradas |
| 3 | `/treino upper B` | Cargas e alvos na hora (sem 👀) |
| 4 | `supino 32kg 10 9 8` | Anexado à sessão aberta |
| 5 | `/desfazer` | "↩️ Desfeito: 3 séries." |
| 6 | De **outro** número, mande `oi` e `/ajuda` ao bot | Nenhuma resposta; log em nível debug |
| 7 | Mande uma foto **sem legenda** e, em até 10 s, o texto `almoço` | Um único turno (uma resposta) para os dois |
| 8 | Responda (citando) a resposta do item 2 com `remada foi 62,5kg` | O coach recebe o bloco `<quoted>` (correção completa vem na Fase 3) |
| 9 | Peça algo que gere resposta longa (ex.: `/ajuda`) | Mensagem inteira; acima de ~3.500 caracteres, chega em até 3 partes |
| 10 | `/status` | "Canal: open desde …", último turno, custo do dia |
| 11 | `sudo systemctl restart impetus` (ou Ctrl+C e `npm run dev`) e mande `/status` | Reconecta sozinho, sem novo `wa:link`; mensagens antigas não são reprocessadas |

Se algo falhar, me mande o trecho do log (`journalctl -u impetus` ou o terminal) e o número do cenário.
