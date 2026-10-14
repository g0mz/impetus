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

### 1.1 Fallback: E2.1.Micro (1 GB)
Funciona para uso pessoal, mais lento:
```bash
sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/99-swap.conf
```
Defina `MODEL_FAST=haiku` e `REPORT_CHARTS=false`.

## 2. Preparação do sistema

```bash
sudo apt update && sudo apt -y upgrade
sudo apt -y install build-essential python3 git sqlite3 rclone unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades

# Node 22 LTS (nodesource ou fnm)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt -y install nodejs

# usuário de serviço
sudo useradd -m -s /bin/bash fitcoach
sudo mkdir -p /etc/fitcoach && sudo chown root:fitcoach /etc/fitcoach && sudo chmod 750 /etc/fitcoach
```

## 3. Claude Code headless

1. Como `fitcoach`, instale o Claude Code pelo método atual da documentação oficial (instalador nativo ou npm). Confira com `claude --version`.
2. **No seu PC**, com navegador: `claude setup-token`. Faça login com a conta da assinatura e copie o token `sk-ant-oat01-…`. Ele vale ~1 ano; anote a data de expiração exibida.
3. Na VM, em `/etc/fitcoach/env` (modo 600):
   ```
   CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...
   CLAUDE_TOKEN_EXPIRES_AT=2027-10-13
   ```
4. **Não** faça login interativo (`/login`) com o usuário `fitcoach`. Há relatos de credenciais salvas e expiradas tendo precedência sobre o token do ambiente. Nem defina `ANTHROPIC_API_KEY` junto, pois os dois conflitam.
5. Teste:
   ```bash
   sudo -u fitcoach bash -lc 'set -a; . /etc/fitcoach/env; set +a; \
     claude auth status && claude -p "responda só: ok" --output-format json'
   ```
   `authMethod` deve ser `oauth_token` e `result` deve ser `ok`.
6. **Cobrança:** hoje o `-p` consome a cota da assinatura. A Anthropic chegou a anunciar a separação do uso programático em junho de 2026 e depois suspendeu. Acompanhe o custo estimado nos logs de `turns` e no `/status`.

## 4. App

```bash
sudo -iu fitcoach
git clone <seu-repo> ~/fitcoach && cd ~/fitcoach
npm ci && npm run build
cp runtime/.env.example /etc/fitcoach/env.app   # editar valores
npm run db:migrate && npm run db:seed
```

Unit do systemd: `runtime/deploy/fitcoach.service` → `/etc/systemd/system/`.
```bash
sudo systemctl daemon-reload && sudo systemctl enable --now fitcoach
journalctl -u fitcoach -f
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
2. Instale o **HC Webhook** (Play Store, `com.hcwebhook.app`). Conceda leitura só dos tipos usados (DATA_MODEL.md §4).
3. Webhook URL: endpoint abaixo; header `X-Api-Key: <INGEST_API_KEY>`; formato JSON; sync por intervalo (ex.: 1 h).
4. Desative a otimização de bateria para Mi Fitness e HC Webhook (Configurações → Apps → Bateria → Sem restrições). Em aparelhos Xiaomi, ative também o "Início automático".

### Rede: escolha uma opção
**A) Tailscale (recomendado, nenhuma porta pública):**
```bash
curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up
sudo tailscale serve --bg --https=443 http://127.0.0.1:8787
```
Instale o Tailscale no celular, na mesma conta. URL: `https://<vm>.<tailnet>.ts.net/ingest/health`. O celular precisa estar conectado à tailnet no momento do sync; deixe o Tailscale como VPN sempre ativa.

**B) Caddy + DuckDNS (HTTPS público):** subdomínio gratuito no DuckDNS, Caddy com TLS automático em 443 → `127.0.0.1:8787`. Abra a 443 na Security List da VCN **e** no iptables da imagem Ubuntu da OCI, que vem bloqueando tudo exceto SSH:
```bash
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

Teste: `curl -X POST <url> -H "X-Api-Key: …" -H "Content-Type: application/json" -d @tests/fixtures/hc_sample.json`.

## 7. Backup e restore

`scripts/backup.sh` (job diário 03:30):
```bash
sqlite3 "$DATA_DIR/fitcoach.db" ".backup '$DATA_DIR/backups/fitcoach-$(date +%F).db'"
gzip -f "$DATA_DIR/backups/fitcoach-$(date +%F).db"
rclone copy "$DATA_DIR/backups/" gcrypt:fitcoach/db/ --max-age 48h
rclone sync "$DATA_DIR/media/" gcrypt:fitcoach/media/          # semanal (domingo)
find "$DATA_DIR/backups/" -name '*.db.gz' -mtime +14 -delete  # retenção local
```
- `gcrypt` é um remote **rclone crypt** sobre o Google Drive (`rclone config`: crie `gdrive` e depois `gcrypt` apontando para `gdrive:fitcoach-enc`). Guarde a senha do crypt fora da VM.
- Retenção remota: 30 diários + 12 mensais (script de poda mensal).
- **Restore:** VM nova → §2–4 → `rclone copy gcrypt:fitcoach/db/<arquivo> .` → `gunzip` → `data/fitcoach.db` → refazer o vínculo do WhatsApp (§5). **Teste o restore uma vez** na Fase 6.

## 8. Operação

| Tarefa | Como |
|---|---|
| Logs | `journalctl -u fitcoach -f` (pino JSON; `npm run logs:pretty` formata) |
| Saúde | `/status` no WhatsApp; `GET 127.0.0.1:8787/healthz` |
| Atualizar | `git pull && npm ci && npm run build && npm run db:migrate && sudo systemctl restart fitcoach` |
| Renovar token Claude | `claude setup-token` no PC → atualizar `/etc/fitcoach/env` → `systemctl restart fitcoach` |
| Revincular WhatsApp | `systemctl stop fitcoach` → apagar `data/wa-auth/` → `npm run wa:link` → start |
| Recuperação de ociosidade | Instâncias Always Free ociosas podem ser recuperadas pela Oracle; PAYG fica isento. Confira a política atual |
