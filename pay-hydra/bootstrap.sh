#!/usr/bin/env bash
# Voidly Pay Hydra bootstrap.
# Brings up a new Voidly Pay provider on any Linux / macOS host.
# Idempotent — safe to re-run. Re-using the same key re-uses the same DID.
set -euo pipefail

MODE="provider"
CAPABILITY="echo.lite"
PRICE="0.0005"
SLA_HOURS="1"
PORT="8420"
FEDERATION_PR="0"
INSTALL_SYSTEMD="0"
KEY_FILE=""

for arg in "$@"; do
  case "$arg" in
    --mode=*)            MODE="${arg#*=}" ;;
    --capability=*)      CAPABILITY="${arg#*=}" ;;
    --price=*)           PRICE="${arg#*=}" ;;
    --sla-hours=*)       SLA_HOURS="${arg#*=}" ;;
    --port=*)            PORT="${arg#*=}" ;;
    --federation-pr=*)   FEDERATION_PR="${arg#*=}" ;;
    --install-systemd)   INSTALL_SYSTEMD="1" ;;
    --key-file=*)        KEY_FILE="${arg#*=}" ;;
    -h|--help)
      grep -E '^# ' "$0" | sed 's/^# //'
      echo ""
      echo "Flags:"
      grep -E '^\s+--' "$0" | head -20
      exit 0
      ;;
  esac
done

echo "──────────────────────────────────────────────"
echo " Voidly Pay Hydra bootstrap"
echo "──────────────────────────────────────────────"
echo "  mode:        $MODE"
echo "  capability:  $CAPABILITY"
echo "  price (cr):  $PRICE"
echo "  SLA (hrs):   $SLA_HOURS"
echo "  port:        $PORT"
echo "──────────────────────────────────────────────"

# ── Deps ────────────────────────────────────────────────────────────────
if ! command -v node >/dev/null 2>&1; then
  echo "fatal: Node.js ≥ 18 is required" >&2
  exit 1
fi
NODE_MAJOR=$(node -e 'console.log(process.versions.node.split(".")[0])')
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "fatal: Node ≥ 18 required (found $(node -v))" >&2
  exit 1
fi

HYDRA_HOME="${HYDRA_HOME:-$HOME/.voidly-hydra}"
mkdir -p "$HYDRA_HOME/keys"
chmod 700 "$HYDRA_HOME/keys"

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$HYDRA_HOME"

if [ ! -f "$HYDRA_HOME/package.json" ]; then
  echo "→ Installing @voidly/pay-sdk in $HYDRA_HOME …"
  npm init -y >/dev/null
  npm install --silent --no-audit --no-fund @voidly/pay-sdk@latest >/dev/null
fi

# ── Load or generate keypair ────────────────────────────────────────────
if [ -n "$KEY_FILE" ] && [ -f "$KEY_FILE" ]; then
  cp "$KEY_FILE" "$HYDRA_HOME/keys/active.json"
  chmod 600 "$HYDRA_HOME/keys/active.json"
  echo "→ Loaded existing key from $KEY_FILE"
elif [ ! -f "$HYDRA_HOME/keys/active.json" ]; then
  echo "→ Generating fresh Ed25519 keypair …"
  node <<EOF >"$HYDRA_HOME/keys/.tmp"
const { generateKeyPair } = require('@voidly/pay-sdk')
const kp = generateKeyPair()
console.log(JSON.stringify({
  did: kp.did,
  publicKeyBase64: kp.publicKeyBase64,
  secretKeyBase64: kp.secretKeyBase64,
  generated_at: new Date().toISOString(),
}))
EOF
  mv "$HYDRA_HOME/keys/.tmp" "$HYDRA_HOME/keys/active.json"
  chmod 600 "$HYDRA_HOME/keys/active.json"
else
  echo "→ Reusing existing key at $HYDRA_HOME/keys/active.json"
fi

DID=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$HYDRA_HOME/keys/active.json')).did)")
echo "→ DID: $DID"

# Save a DID-named symlink so /opt deploys can pin
ln -sf "active.json" "$HYDRA_HOME/keys/latest.json"

# ── Write env file (secure) ─────────────────────────────────────────────
cat > "$HYDRA_HOME/.env" <<EOF
VOIDLY_API=https://api.voidly.ai
VOIDLY_HYDRA_DID=$DID
VOIDLY_HYDRA_KEYFILE=$HYDRA_HOME/keys/active.json
VOIDLY_HYDRA_MODE=$MODE
VOIDLY_HYDRA_CAPABILITY=$CAPABILITY
VOIDLY_HYDRA_PRICE=$PRICE
VOIDLY_HYDRA_SLA_HOURS=$SLA_HOURS
VOIDLY_HYDRA_PORT=$PORT
EOF
chmod 600 "$HYDRA_HOME/.env"

# ── Systemd install (optional) ─────────────────────────────────────────
if [ "$INSTALL_SYSTEMD" = "1" ]; then
  if [ "$(id -u)" != "0" ]; then
    echo "→ --install-systemd requires sudo — re-exec with sudo" >&2
    exit 1
  fi
  echo "→ Installing systemd unit at /etc/systemd/system/voidly-hydra.service"
  sed -e "s#__HYDRA_HOME__#$HYDRA_HOME#g" -e "s#__SCRIPT_DIR__#$SCRIPT_DIR#g" \
      "$SCRIPT_DIR/voidly-hydra-provider.service" > /etc/systemd/system/voidly-hydra.service
  systemctl daemon-reload
  systemctl enable --now voidly-hydra
  echo "→ Service status:"
  systemctl --no-pager status voidly-hydra | head -8
  exit 0
fi

# ── Run ────────────────────────────────────────────────────────────────
echo ""
echo "→ Launching $MODE loop (Ctrl-C to stop) …"
echo ""
# Inline the .env so the child sees it.
set -a; . "$HYDRA_HOME/.env"; set +a
exec node "$SCRIPT_DIR/agent.js"
