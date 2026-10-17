#!/usr/bin/env bash
# Prepara a VM (Ubuntu 24.04, arm64 ou x86_64) para o Impetus — DEPLOY.md §2–4. Idempotente: pode rodar de novo.
# Em VM de pouca memória (E2.1.Micro, 1 GB) cria swap e reduz a paralelização do build.
# Uso (como um usuário com sudo):  REPO_URL=https://github.com/<você>/impetus.git bash setup-vm.sh
set -euo pipefail

REPO_URL="${REPO_URL:?defina REPO_URL}"
BRANCH="${BRANCH:-main}"
APP_USER=impetus
APP_HOME="/home/$APP_USER"
APP_DIR="$APP_HOME/impetus"

log() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }

ARCH="$(uname -m)"
RAM_MB="$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)"
LOW_MEM=0
[[ "$RAM_MB" -lt 2048 ]] && LOW_MEM=1
log "shape: $ARCH, ${RAM_MB} MB de RAM$([[ $LOW_MEM == 1 ]] && echo ' (modo pouca memória)')"

# Sem swap, 1 GB não aguenta `npm ci` nem o build do whisper.cpp.
if [[ $LOW_MEM == 1 && "$(awk 'NR>1 {s+=$3} END {print s+0}' /proc/swaps)" -lt 1048576 ]]; then
  log "swap de 4 GB"
  if [[ ! -f /swapfile ]]; then
    sudo fallocate -l 4G /swapfile || sudo dd if=/dev/zero of=/swapfile bs=1M count=4096
    sudo chmod 600 /swapfile
    sudo mkswap /swapfile
  fi
  sudo swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
  echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/99-swap.conf >/dev/null
  sudo sysctl -q -p /etc/sysctl.d/99-swap.conf
fi

log "pacotes do sistema"
sudo apt-get update -y
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y build-essential python3 git sqlite3 rclone \
  unattended-upgrades fonts-dejavu-core ca-certificates curl ffmpeg cmake

if ! command -v node >/dev/null || [[ "$(node -v)" != v24* ]]; then
  log "Node 24 LTS"
  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

log "usuário de serviço"
id "$APP_USER" >/dev/null 2>&1 || sudo useradd -m -s /bin/bash "$APP_USER"
sudo mkdir -p /etc/impetus
sudo chown root:"$APP_USER" /etc/impetus && sudo chmod 750 /etc/impetus
if [[ ! -f /etc/impetus/env ]]; then
  sudo install -m 640 -o root -g "$APP_USER" /dev/null /etc/impetus/env
  echo "   /etc/impetus/env criado VAZIO: coloque CLAUDE_CODE_OAUTH_TOKEN, CLAUDE_TOKEN_EXPIRES_AT e INGEST_API_KEY"
fi

log "código"
if [[ -d "$APP_DIR/.git" ]]; then
  sudo -u "$APP_USER" git -C "$APP_DIR" fetch --quiet origin
  sudo -u "$APP_USER" git -C "$APP_DIR" checkout --quiet "$BRANCH"
  sudo -u "$APP_USER" git -C "$APP_DIR" pull --ff-only --quiet
else
  sudo -u "$APP_USER" git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi
[[ -f /etc/impetus/env.app ]] || sudo install -m 640 -o root -g "$APP_USER" "$APP_DIR/runtime/.env.example" /etc/impetus/env.app

log "dependências e build"
sudo -u "$APP_USER" bash -lc "cd '$APP_DIR' && npm ci --no-audit --no-fund && npm run build"
sudo -u "$APP_USER" mkdir -p "$APP_HOME/.local/state/impetus/brain" "$APP_DIR/data"
sudo chmod 700 "$APP_DIR/data"

# Compilar o whisper leva horas numa E2.1.Micro (1/8 OCPU): WHISPER=0 pula e deixa a voz desligada.
WHISPER="${WHISPER:-1}"
if [[ "$WHISPER" == 0 ]]; then
  log "whisper.cpp: pulado (WHISPER=0) — deixe TRANSCRIBE desligado em env.app"
else
log "whisper.cpp (mensagens de voz)"
WHISPER_TAG="${WHISPER_TAG:-v1.9.5}"
WHISPER_DIR="$APP_HOME/whisper.cpp"
# Em 1 GB, o small-q5_1 (~190 MB em RAM) concorre com o node e o claude: usa o base.
if [[ $LOW_MEM == 1 ]]; then
  WHISPER_MODEL_NAME="${WHISPER_MODEL_NAME:-ggml-base-q5_1.bin}"
  WHISPER_JOBS="-j1"
else
  WHISPER_MODEL_NAME="${WHISPER_MODEL_NAME:-ggml-small-q5_1.bin}"
  WHISPER_JOBS="-j"
fi
if [[ ! -x "$WHISPER_DIR/build/bin/whisper-cli" ]]; then
  [[ -d "$WHISPER_DIR/.git" ]] || sudo -u "$APP_USER" git clone --depth 1 --branch "$WHISPER_TAG" https://github.com/ggml-org/whisper.cpp "$WHISPER_DIR"
  sudo -u "$APP_USER" bash -lc "cd '$WHISPER_DIR' && cmake -B build -DCMAKE_BUILD_TYPE=Release -DWHISPER_BUILD_TESTS=OFF && cmake --build build $WHISPER_JOBS --config Release --target whisper-cli"
fi
if [[ ! -f "$WHISPER_DIR/models/$WHISPER_MODEL_NAME" ]]; then
  sudo -u "$APP_USER" curl -fL -o "$WHISPER_DIR/models/$WHISPER_MODEL_NAME"     "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$WHISPER_MODEL_NAME"
fi
echo "   TRANSCRIBE=whisper-cpp  WHISPER_BIN=$WHISPER_DIR/build/bin/whisper-cli  WHISPER_MODEL=$WHISPER_DIR/models/$WHISPER_MODEL_NAME"
fi

log "Claude Code"
if ! sudo -u "$APP_USER" bash -lc 'command -v claude' >/dev/null; then
  echo "   instale como $APP_USER pelo método atual da documentação oficial (DEPLOY.md §3) e rode este script de novo"
fi

log "serviço systemd"
sudo install -m 644 "$APP_DIR/runtime/deploy/impetus.service" /etc/systemd/system/impetus.service
sudo systemctl daemon-reload
sudo systemctl enable impetus >/dev/null

cat <<MSG

Pronto. Próximos passos:
  1. sudo nano /etc/impetus/env       (segredos)   ·  sudo nano /etc/impetus/env.app (CHANNEL=whatsapp, NODE_ENV=production, DATA_DIR=$APP_DIR/data, BRAIN_DIR=$APP_HOME/.local/state/impetus/brain)
  2. WhatsApp: copie data/wa-auth do PC (com o app do PC PARADO) para $APP_DIR/data/wa-auth  —  ou rode wa:link aqui
  3. Banco do PC (opcional): pare o app do PC e copie data/impetus.db para $APP_DIR/data/
  4. sudo systemctl restart impetus && journalctl -u impetus -f
MSG

if [[ $LOW_MEM == 1 ]]; then
  cat <<'MSG'
VM de pouca memória: em /etc/impetus/env.app use MODEL_FAST=haiku e REPORT_CHARTS=false
(o render dos gráficos é o pico de memória).
MSG
fi
