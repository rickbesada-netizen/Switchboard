#!/usr/bin/env bash
# Installs (or updates) the Switchboard server on Ubuntu, e.g. an Oracle Cloud "Always Free" VM.
#   Install:  curl -fsSL https://github.com/rickbesada-netizen/Switchboard/releases/latest/download/install-server.sh | sudo bash
#   Sign in again:  sudo switchboard-signin
#   Logs:     journalctl -u switchboard -f
set -euo pipefail
REPO=rickbesada-netizen/Switchboard
MODE=${1:-install}
[ "$(id -u)" = 0 ] || { echo "Please run this with sudo."; exit 1; }
case "$(uname -m)" in aarch64|arm64) ARCH=arm64 ;; x86_64|amd64) ARCH=amd64 ;; *) echo "Unsupported processor: $(uname -m)"; exit 1 ;; esac
command -v apt-get >/dev/null || { echo "This needs Ubuntu (choose the Canonical Ubuntu image when creating the server)."; exit 1; }

latest=$(curl -fsSL https://api.github.com/repos/$REPO/releases/latest | sed -n 's/.*"tag_name": *"v\{0,1\}\([^"]*\)".*/\1/p' | head -1)
current=$(node -p "require('/opt/switchboard/package.json').version" 2>/dev/null || echo none)
if [ "$MODE" = update ] && [ "$latest" = "$current" ]; then exit 0; fi
echo "== Switchboard server $latest ($ARCH)"

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  echo "== Installing Node.js"
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg >/dev/null
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
id switchboard >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/switchboard --shell /usr/sbin/nologin switchboard

echo "== Downloading Switchboard"
tmp=$(mktemp -d)
curl -fsSL -o "$tmp/sb.tgz" "https://github.com/$REPO/releases/latest/download/switchboard-server-linux-$ARCH.tar.gz"
mkdir -p "$tmp/x" && tar -xzf "$tmp/sb.tgz" -C "$tmp/x" --strip-components=1
systemctl stop switchboard 2>/dev/null || true
rm -rf /opt/switchboard && mv "$tmp/x" /opt/switchboard && rm -rf "$tmp"
chmod +x /opt/switchboard/engine/bin/engine

echo "== Installing the browser used for posting (takes a minute)"
mkdir -p /opt/switchboard-browsers
PLAYWRIGHT_BROWSERS_PATH=/opt/switchboard-browsers node /opt/switchboard/node_modules/playwright-core/cli.js install --with-deps chromium >/dev/null 2>&1 \
  || echo "   (browser install failed; messaging still works, posting won't until this is fixed)"
chmod -R a+rX /opt/switchboard-browsers

cat > /etc/systemd/system/switchboard.service <<UNIT
[Unit]
Description=Switchboard server
After=network-online.target
Wants=network-online.target

[Service]
User=switchboard
Environment=SB_HOME=/var/lib/switchboard
Environment=PLAYWRIGHT_BROWSERS_PATH=/opt/switchboard-browsers
ExecStart=/usr/bin/node /opt/switchboard/server/index.js
Restart=always
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
UNIT

cat > /usr/local/bin/switchboard-signin <<'SIGN'
#!/usr/bin/env bash
[ "$(id -u)" = 0 ] || { echo "Please run: sudo switchboard-signin"; exit 1; }
systemctl stop switchboard 2>/dev/null || true
sudo -u switchboard env SB_HOME=/var/lib/switchboard node /opt/switchboard/server/index.js signin < /dev/tty
systemctl start switchboard
SIGN
chmod +x /usr/local/bin/switchboard-signin

# check for a new version every night
cp /opt/switchboard/server/install.sh /usr/local/bin/switchboard-install && chmod +x /usr/local/bin/switchboard-install
cat > /etc/cron.d/switchboard-update <<'CRON'
17 4 * * * root /usr/local/bin/switchboard-install update >> /var/log/switchboard-update.log 2>&1
CRON

systemctl daemon-reload
systemctl enable switchboard >/dev/null 2>&1
if [ ! -f /var/lib/switchboard/data/cloud-session.bin ] && [ "$MODE" != update ]; then
  echo
  echo "== Sign in with your Switchboard account"
  sudo -u switchboard env SB_HOME=/var/lib/switchboard node /opt/switchboard/server/index.js signin < /dev/tty || true
fi
systemctl restart switchboard
echo
echo "Done. Switchboard is running and starts by itself whenever the server restarts."
echo "Logs: journalctl -u switchboard -f"
