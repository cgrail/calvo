#!/usr/bin/env bash
# ============================================================
# calvo — deploy onto the mech-vs-mech box
#
# Adds calvo (calendar voting) to an Ubuntu server that was already
# set up by mech-vs-mech's install.sh in Let's Encrypt mode (Caddy
# terminating HTTPS on the box). That script owns the OS hardening,
# firewall, Node.js and Caddy install; this one only deploys the app:
#
#   App     code synced to /opt/calvo, owned by root, run by the
#           unprivileged user "calvo" (service can't modify itself)
#   Data    /var/lib/calvo/data/availability.json — survives deploys
#   Run     sandboxed systemd unit, loopback-only on 127.0.0.1:3000
#   TLS     Caddy site file /etc/caddy/apps/calvo.caddy serving
#           https://$DOMAIN with an auto-issued/renewed certificate
#   Update  systemd timer runs update.sh every 5 minutes,
#           auto-deploying whatever lands on origin/main
#
# Usage — run ON the server, from a checkout of this repo:
#
#   git clone https://github.com/cgrail/calvo.git && cd calvo
#   sudo ./install.sh                          # https://calvo.grails.de
#   sudo DOMAIN=cal.example.com ./install.sh   # different hostname
#
# DOMAIN is remembered in /etc/default/calvo, so re-runs are plain
# `sudo ./install.sh`. Re-running is safe: it re-syncs the code,
# restarts the service and refreshes the Caddy site.
#
# DNS: point a plain UN-proxied A/AAAA record for $DOMAIN at this
# box — Caddy keeps retrying issuance until it resolves here.
# ============================================================
set -Eeuo pipefail # -E: the ERR trap below also fires inside functions

APP_DIR=/opt/calvo
APP_USER=calvo
APP_HOME=/var/lib/calvo
APP_PORT=3000
DEFAULTS_FILE=/etc/default/calvo
CADDY_SITE=/etc/caddy/apps/calvo.caddy
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log()  { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
warn() { printf '\n\033[1;33m!!  %s\033[0m\n' "$*"; }
die()  { printf '\n\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

# set -e aborts on any failure — make sure it never does so silently
trap 'die "install.sh failed at line $LINENO: $BASH_COMMAND"' ERR

# ---------- preflight ----------
[[ $EUID -eq 0 ]] || die "run with sudo: sudo ./install.sh"
[[ -f $SRC_DIR/package.json && -f $SRC_DIR/server.js ]] \
  || die "run this script from a checkout of the calvo repo"
command -v node > /dev/null \
  || die "Node.js missing — run mech-vs-mech's install.sh on this box first"
command -v caddy > /dev/null && systemctl is-active --quiet caddy \
  || die "Caddy is not running — calvo shares ports 80/443 through Caddy, so
       this box must be in Let's Encrypt mode: run mech-vs-mech's install.sh
       with DOMAIN=… first, then re-run this script"

# ---------- domain (remembered across runs) ----------
if [[ -z ${DOMAIN+x} && -f $DEFAULTS_FILE ]]; then
  DOMAIN="$(sed -n 's/^DOMAIN=//p' "$DEFAULTS_FILE" | tail -1)"
fi
DOMAIN="${DOMAIN:-calvo.grails.de}"
[[ $DOMAIN =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] \
  || die "DOMAIN doesn't look like a hostname: $DOMAIN"
log "calvo will be served at https://$DOMAIN"

# ---------- app user + code ----------
if ! id -u "$APP_USER" > /dev/null 2>&1; then
  log "Creating system user '$APP_USER'"
  useradd --system --home-dir "$APP_HOME" --create-home --shell /usr/sbin/nologin "$APP_USER"
fi

log "Syncing code to $APP_DIR and installing dependencies"
install -d -m 755 "$APP_DIR"
rsync -a --delete --exclude .git --exclude node_modules --exclude data "$SRC_DIR/" "$APP_DIR/"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"
runuser -u "$APP_USER" -- bash -c "cd '$APP_DIR' && HOME='$APP_HOME' npm ci --omit=dev --no-audit --no-fund"
# the service user may read the code but never write it
chown -R "root:$APP_USER" "$APP_DIR"
chmod -R g-w,o-rwx "$APP_DIR"

# ---------- systemd service (sandboxed) ----------
log "Installing systemd service"
cat > "$DEFAULTS_FILE" <<EOF
# calvo tunables — rewritten by every install.sh run
PORT=$APP_PORT
HOST=127.0.0.1
DATA_DIR=$APP_HOME/data
DOMAIN=$DOMAIN
EOF
cat > /etc/systemd/system/calvo.service <<EOF
[Unit]
Description=calvo calendar voting server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=-$DEFAULTS_FILE
Environment=NODE_ENV=production
ExecStart=/usr/bin/node $APP_DIR/server.js
Restart=always
RestartSec=2
LimitNOFILE=65535

# resource ceilings — a kill+restart just reloads the JSON file
MemoryMax=256M
TasksMax=32

# sandbox: read-only everything except the state dir; no capabilities
# needed on an unprivileged loopback port.
# (No MemoryDenyWriteExecute — the V8 JIT needs W+X pages.)
NoNewPrivileges=yes
ProtectSystem=strict
StateDirectory=calvo
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
ProtectProc=invisible
ProcSubset=pid
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
SystemCallFilter=@system-service
SystemCallErrorNumber=EPERM
SystemCallArchitectures=native
CapabilityBoundingSet=
UMask=0077

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable calvo
systemctl restart calvo

# record what's deployed so update.sh's timer doesn't redeploy it
runuser -u "$(stat -c %U "$SRC_DIR")" -- git -C "$SRC_DIR" rev-parse HEAD \
  > "$APP_HOME/deployed-rev" 2>/dev/null || true

# ---------- Caddy site ----------
log "Configuring Caddy → https://$DOMAIN"
install -d -m 755 /etc/caddy/apps
cat > "$CADDY_SITE" <<EOF
# managed by calvo install.sh — re-runs overwrite this file
$DOMAIN {
	# app server (HTTP + WebSocket /ws) on the loopback interface
	reverse_proxy 127.0.0.1:$APP_PORT
}
EOF
# the main Caddyfile belongs to mech-vs-mech's install.sh; current versions
# emit this import themselves — append it only if it's missing
if ! grep -qF 'import /etc/caddy/apps/*.caddy' /etc/caddy/Caddyfile; then
  printf '\nimport /etc/caddy/apps/*.caddy\n' >> /etc/caddy/Caddyfile
fi
caddy validate --config /etc/caddy/Caddyfile > /dev/null 2>&1 \
  || die "/etc/caddy/Caddyfile fails validation after adding $CADDY_SITE"
systemctl reload-or-restart caddy

# ---------- auto-update: track origin/main every 5 min ----------
log "Installing auto-update timer (update.sh)"
cat > /etc/systemd/system/calvo-update.service <<EOF
[Unit]
Description=calvo auto-update (fetch origin, redeploy, restart)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/bin/bash $SRC_DIR/update.sh
EOF
cat > /etc/systemd/system/calvo-update.timer <<EOF
[Unit]
Description=calvo update check every 5 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
RandomizedDelaySec=30

[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now calvo-update.timer

# ---------- summary ----------
sleep 2
log "Done"
systemctl --no-pager --quiet is-active calvo \
  && echo "  calvo        : running on 127.0.0.1:$APP_PORT (behind Caddy)" \
  || warn "calvo is NOT running — check: journalctl -u calvo"
cat <<EOF

  dns          : point a plain UN-proxied A/AAAA record for $DOMAIN at this
                 box — Caddy keeps retrying issuance until it resolves here
  certificate  : Let's Encrypt via Caddy, auto-issued + auto-renewed;
                 watch issuance: journalctl -u caddy -f
  firewall     : untouched — 80/443 are already open from the
                 mech-vs-mech setup; calvo's port is loopback-only
  data         : $APP_HOME/data/availability.json (survives redeploys)
  logs         : journalctl -u calvo -f
  quick check  : curl -sI https://$DOMAIN/ | head -1
  updates      : auto — pushes to origin/main go live within ~5 min
                 (calvo-update.timer → update.sh, discards local edits
                 in this checkout); manual: sudo ./update.sh --force
EOF
