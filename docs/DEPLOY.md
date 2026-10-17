# DEPLOY — Oracle Cloud + Claude Code + WhatsApp

> Verifique os limites e políticas atuais antes de cada passo. Oracle e Anthropic mudaram regras várias vezes em 2026.

## 1. VM na Oracle Cloud

### Conta
1. Crie a conta OCI. A **home region** é definitiva e só ela tem recursos Always Free. Se ainda não criou a conta, prefira uma região menos disputada que São Paulo; a latência não importa para um bot.
2. **Upgrade para Pay As You Go (recomendado):** contas PAYG conseguem capacidade A1 com muito mais facilidade e ficam fora da recuperação de instâncias ociosas. Os recursos Always Free continuam sem custo.
3. **Budget alert** imediatamente: Billing → Budgets → R$ 1 / US$ 1, alerta por e-mail em 1%.

### Limites Always Free atuais (2026)
| Recurso | Limite |
|---|---|
| Ampere A1 (arm64) | **2 OCPU e 12 GB de RAM no total** (1.500 OCPU-h e 9.000 GB-h/mês). O limite era 4/24 até meados de 2026 |
| AMD E2.1.Micro (x86) | 2 instâncias de 1/8 OCPU e 1 GB |
| Block storage | 200 GB no total (boot volume mínimo de ~47 GB) |

No PAYG, **qualquer coisa acima disso é cobrada**. Não crie A1 com mais de 2 OCPU / 12 GB.

### Instância
- Shape `VM.Standard.A1.Flex`, **2 OCPU / 12 GB**, imagem **Ubuntu 24.04 (aarch64)**, boot volume de 50 GB.
- Confirme o selo **Always Free-eligible** na criação.
- Chave SSH própria; IP público efêmero basta.
- Sem capacidade A1 na região: tente outro *availability domain* ou use `VM.Standard.E2.1.Micro` (§1.1).

### 1.1 Fallback: E2.1.Micro (1 GB, x86_64)
Funciona para uso pessoal, mais lento. O `setup-vm.sh` detecta a arquitetura e a memória: abaixo de 2 GB ele cria
o swap de 4 GB (`/swapfile`, `vm.swappiness=10`), compila o whisper.cpp com um job só e usa o modelo
`ggml-base-q5_1` em vez do `small`. Nada disso precisa ser feito à mão.

Ajuste você mesmo em `/etc/impetus/env.app`: `MODEL_FAST=haiku` e `REPORT_CHARTS=false` (o render dos gráficos é o
pico de memória).

Para trocar de shape depois (A1 liberando capacidade): rode o `setup-vm.sh` na VM nova e siga a migração do §7
(copiar `data/wa-auth` e `data/impetus.db` com o app parado).

## 2. Preparação do sistema

> Atalho: `REPO_URL=https://github.com/<você>/impetus.git bash runtime/deploy/setup-vm.sh` faz §2 e §4 (idempotente). Os passos manuais abaixo continuam valendo como referência.

```bash
sudo apt update && sudo apt -y upgrade
sudo apt -y install build-essential python3 git sqlite3 rclone unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades

# Node 24 LTS (nodesource ou fnm)
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt -y install nodejs

# usuário de serviço
sudo useradd -m -s /bin/bash impetus
sudo mkdir -p /etc/impetus && sudo chown root:impetus /etc/impetus && sudo chmod 750 /etc/impetus
```

## 3. Claude Code headless

1. Como `impetus`, instale o Claude Code pelo método atual da documentação oficial (instalador nativo ou npm). Confira com `claude --version`.
2. **No seu PC**, com navegador: `claude setup-token`. Faça login com a conta da assinatura e copie o token `sk-ant-oat01-…`. Ele vale ~1 ano; anote a data de expiração exibida.
3. Na VM, em `/etc/impetus/env` (modo 600):
   ```
   CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...
   CLAUDE_TOKEN_EXPIRES_AT=2027-10-13
   ```
4. **Não** faça login interativo (`/login`) com o usuário `impetus`. Há relatos de credenciais salvas e expiradas tendo precedência sobre o token do ambiente. Nem defina `ANTHROPIC_API_KEY` junto, pois os dois conflitam.
5. Teste:
   ```bash
   sudo -u impetus bash -lc 'set -a; . /etc/impetus/env; set +a; \
     claude auth status && claude -p "responda só: ok" --output-format json'
   ```
   `authMethod` deve ser `oauth_token` e `result` deve ser `ok`.
6. **Cobrança:** hoje o `-p` consome a cota da assinatura. A Anthropic chegou a anunciar a separação do uso programático em junho de 2026 e depois suspendeu. Acompanhe o custo estimado nos logs de `turns` e no `/status`.

## 4. App

```bash
sudo -iu impetus
git clone <seu-repo> ~/impetus && cd ~/impetus
npm ci && npm run build
cp runtime/.env.example /etc/impetus/env.app   # editar valores
npm run db:migrate && npm run db:seed
```

Unit do systemd: `runtime/deploy/impetus.service` → `/etc/systemd/system/`.
```bash
sudo systemctl daemon-reload && sudo systemctl enable --now impetus
journalctl -u impetus -f
```

## 5. WhatsApp (Baileys)

### Número do bot
- **Chip secundário** com WhatsApp (ou WhatsApp Business) num celular qualquer. Esse número vira o bot.
- Nunca use seu número principal.

### Vincular o bot (uma vez)
`npm run wa:link -- --phone 55DDNNNNNNNNN` pede um **código de pareamento** ao Baileys (`requestPairingCode`). No celular do chip: WhatsApp → Aparelhos conectados → Conectar com número de telefone → digite o código. Sem esse método, use o QR exibido no terminal (`npm run wa:link -- --qr`).

A sessão fica em `data/wa-auth/`. Essa pasta é credencial: permissões 700 e **fora** do backup em nuvem.

### Pareamento do dono (allowlist)
No primeiro start sem dono definido, o app gera um código de 6 dígitos e o mostra no log. Do **seu número pessoal**, envie ao bot `PAREAR 123456`. O app grava os identificadores do remetente (JID e LID) em `settings.owner.ids`. A partir daí, só esses remetentes são atendidos.

Isso evita fixar o número no código. Números brasileiros podem ter JID com ou sem o 9º dígito, e o WhatsApp vem migrando para identificadores LID.

### Boas práticas anti-ban
- Responder só ao dono; não entrar em grupos; não mandar mensagem a terceiros.
- Sem rajadas: fila serial e pausa mínima de 1 s entre mensagens enviadas.
- Atualizar o Baileys só após ler o changelog; manter a versão fixada.
- Não instalar pacotes "anti-ban" de terceiros.

## 6. Ingestão do Health Connect

### No celular
1. Mi Fitness → Perfil → Health Connect → ativar e conceder escrita de passos, sono, FC, peso e calorias.
   O Mi Fitness só repassa ao Health Connect dados **posteriores** à ativação, e o histórico não vai. Se a permissão
   estiver dada e nada chegar, desligue e ligue a integração de novo. Para testar na hora, meça a FC manualmente no
   relógio, sincronize o Mi Fitness e confira em Configurações → Health Connect → Dados e acesso → Sinais vitais.
   O sono só é repassado depois de acordar e abrir o Mi Fitness.
2. Instale o **HC Webhook**. Na Play Store ele é pago; o APK FOSS é gratuito no GitHub
   (`github.com/mcnaveen/health-connect-webhook`, release `app-foss-release.apk`, AGPL-3.0). Prefira instalar e
   atualizar pelo **Obtainium**, apontando para esse repositório. Em "Grant Permissions", conceda leitura só dos
   tipos usados (DATA_MODEL.md §4).
3. Em Webhook URLs, adicione o endpoint abaixo. Em Manage Headers → Form: Key `X-Api-Key`, Value
   `<INGEST_API_KEY>`, e depois Add Header. Formato JSON; sync por intervalo de 60 min (mínimo 15). Save.
4. Valide com **Sync Now**; o resultado aparece em ⋮ → Webhook Log, com o status `200`.
   O botão **Test Webhook** manda dados **fictícios** com `test: true`. O ingest responde `{"ok":true,"test":true}`
   e não grava nada (D-032), então ele só serve para testar conexão e chave.
5. Desative a otimização de bateria para Mi Fitness, HC Webhook e Tailscale (Configurações → Apps → Bateria → Sem
   restrições). Em aparelhos Xiaomi, ative também o "Início automático".

Formato real observado (HC Webhook 1.9.22): passos e calorias chegam como um bloco por dia, do início do dia até o
instante do sync, e cada sync substitui o bloco (D-032). A FC chega como leituras de 1 a 10 min com avg/min/max.

### Rede: escolha uma opção
**A) Tailscale (recomendado, nenhuma porta pública):**
```bash
curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up
sudo tailscale serve --bg --https=443 http://127.0.0.1:8787
```
Instale o Tailscale no celular, na mesma conta. URL: `https://<vm>.<tailnet>.ts.net/ingest/health`. O celular precisa estar conectado à tailnet no momento do sync; deixe o Tailscale como VPN sempre ativa.
- **Primeiro `serve`:** numa tailnet nova, o comando devolve um link `login.tailscale.com/f/serve?...` e fica
  esperando. Abra o link e aprove (ou ative em Admin → DNS → HTTPS Certificates); o comando termina sozinho. O
  MagicDNS precisa estar ligado.
- **"Unable to resolve host" no celular:** o Android não está usando o DNS do Tailscale. Coloque Configurações →
  DNS privado em **Desativado** (Automático ou um provedor passam por cima do MagicDNS), deixe "Use Tailscale DNS"
  ligado no app e desligue/ligue a VPN. Teste no navegador do celular:
  `https://<host>.<tailnet>.ts.net/healthz`, digitado com o `https://` para o navegador não tratar como busca.
- **Teste local antes da VM:** funciona igual no PC. Instale o Tailscale no Windows e rode
  `tailscale serve --bg --https=443 http://127.0.0.1:8787` com `npm run dev` rodando e `INGEST_API_KEY` no `.env`.
  A URL fica `https://<pc>.<tailnet>.ts.net/ingest/health`. Na VM, gere outra chave e troque URL e header no app.

**B) Caddy + DuckDNS (HTTPS público):** subdomínio gratuito no DuckDNS, Caddy com TLS automático em 443 → `127.0.0.1:8787`. Abra a 443 na Security List da VCN **e** no iptables da imagem Ubuntu da OCI, que vem bloqueando tudo exceto SSH:
```bash
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

Teste: `curl -X POST <url> -H "X-Api-Key: …" -H "Content-Type: application/json" -d @tests/fixtures/hc_sample.json`.

## 7. Backup e restore

Job `backup` (diário 03:30, `src/ops/backup.ts`, decisão D-028):
- Cópia consistente do SQLite pela API de backup do `better-sqlite3` (segura com WAL e com o app rodando) →
  `DATA_DIR/backups/impetus-AAAA-MM-DD.db.gz`; retenção local de `BACKUP_KEEP_DAYS` (padrão 14).
- Com `BACKUP_REMOTE` (ex.: `gcrypt:impetus`): `rclone copy` dos backups das últimas 48 h para `<remote>/db/` e,
  aos domingos, `rclone sync` de `data/media` para `<remote>/media/`. Falha → alerta crítico no WhatsApp.
- `gcrypt` é um remote **rclone crypt** sobre o Google Drive (`rclone config`: crie `gdrive` e depois `gcrypt`
  apontando para `gdrive:impetus-enc`). Guarde a senha do crypt fora da VM.
- `data/wa-auth` (credencial) **nunca** entra no backup.

**Restore** (testado automaticamente em `tests/integration/ops.test.ts`):
```bash
sudo systemctl stop impetus
mv data/impetus.db data/impetus.db.old          # se existir
rclone copy gcrypt:impetus/db/impetus-AAAA-MM-DD.db.gz data/backups/   # ou use um backup local
npm run restore -- data/backups/impetus-AAAA-MM-DD.db.gz   # confere integrity_check e conta refeições/séries
sudo systemctl start impetus                     # refaça o wa:link se a pasta wa-auth não existir
```

### Migrar do PC para a VM
1. Pare o app no PC (o WhatsApp não pode rodar em dois lugares com a mesma sessão).
2. Copie `data/wa-auth/` e `data/impetus.db` para `~/impetus/data/` na VM (`scp -r`), `chmod 700 data/wa-auth`.
3. `sudo systemctl restart impetus` e confira `whatsapp conectado` no `journalctl`.

## 8. Operação

| Tarefa | Como |
|---|---|
| Logs | `journalctl -u impetus -f` (pino JSON; `npm run logs:pretty` formata) |
| Saúde | `/status` no WhatsApp; `GET 127.0.0.1:8787/healthz` |
| Atualizar | `git pull && npm ci && npm run build && npm run db:migrate && sudo systemctl restart impetus` |
| Renovar token Claude | `claude setup-token` no PC → atualizar `/etc/impetus/env` → `systemctl restart impetus` |
| Revincular WhatsApp | `systemctl stop impetus` → apagar `data/wa-auth/` → `npm run wa:link` → start |
| Recuperação de ociosidade | Instâncias Always Free ociosas podem ser recuperadas pela Oracle; PAYG fica isento. Confira a política atual |
