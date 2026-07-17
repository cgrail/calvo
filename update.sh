#!/usr/bin/env bash
# ============================================================
# calvo — auto-update / deploy
#
# Fetches origin and, when origin/main has moved past what is
# currently deployed, hard-resets this checkout to it (the deploy
# checkout must mirror origin exactly — local edits here are
# discarded), re-syncs /opt/calvo and restarts the service.
#
# install.sh registers this as a systemd timer (every 5 min):
#   systemctl list-timers calvo-update.timer
#   journalctl -u calvo-update
#
# Manual use, from the server checkout:
#   sudo ./update.sh            # deploy only if origin/main moved
#   sudo ./update.sh --force    # redeploy + restart no matter what
#
# A restart is harmless: the availability data lives in
# /var/lib/calvo/data and is reloaded on startup.
# ============================================================
set -euo pipefail

APP_DIR=/opt/calvo
APP_USER=calvo
APP_HOME=/var/lib/calvo
DEPLOYED_REV_FILE=$APP_HOME/deployed-rev
BRANCH="${BRANCH:-main}"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log() { printf '\033[1;32m==> %s\033[0m\n' "$*"; }
die() { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "run with sudo: sudo ./update.sh [--force]"
git -C "$SRC_DIR" rev-parse --is-inside-work-tree > /dev/null 2>&1 \
  || die "$SRC_DIR is not a git checkout"
id -u "$APP_USER" > /dev/null 2>&1 || die "user '$APP_USER' missing — run install.sh first"

# never run two deploys at once (timer tick vs manual run)
exec 9> /run/lock/calvo-deploy.lock
flock -n 9 || die "another deploy is already running"

# git runs as the checkout's owner: keeps ownership clean and avoids
# git's "dubious ownership" refusal when root touches a user's repo
OWNER="$(stat -c %U "$SRC_DIR")"
git_src() { runuser -u "$OWNER" -- git -C "$SRC_DIR" "$@"; }

git_src fetch --quiet origin "$BRANCH"
remote_rev="$(git_src rev-parse "origin/$BRANCH")"
deployed_rev="$(cat "$DEPLOYED_REV_FILE" 2>/dev/null || true)"

if [[ $remote_rev == "$deployed_rev" && ${1:-} != --force ]]; then
  exit 0 # up to date — stay quiet in the 5-minute timer logs
fi

log "deploying ${deployed_rev:-nothing} → $remote_rev"
git_src reset --hard "origin/$BRANCH"

# mirror install.sh's deploy steps: sync, install unprivileged, lock down
rsync -a --delete --exclude .git --exclude node_modules --exclude data "$SRC_DIR/" "$APP_DIR/"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"
runuser -u "$APP_USER" -- bash -c "cd '$APP_DIR' && HOME='$APP_HOME' npm ci --omit=dev --no-audit --no-fund"
chown -R "root:$APP_USER" "$APP_DIR"
chmod -R g-w,o-rwx "$APP_DIR"

systemctl restart calvo

# only mark deployed after a successful install + restart, so a failed
# attempt is retried on the next timer tick
echo "$remote_rev" > "$DEPLOYED_REV_FILE"
log "deployed $remote_rev"
