#!/usr/bin/env bash
# ============================================================
# calvo — data backup
#
# Snapshots the availability data into ~/termin/data (home of the
# user owning this checkout) as availability-YYYYMMDD-HHMMSS.json.
# A new file is only written when the data changed since the newest
# backup, so quiet periods add nothing.
#
# install.sh registers this as a systemd timer (every 5 min):
#   systemctl list-timers calvo-backup.timer
#   journalctl -u calvo-backup
#
# Manual run: sudo ./backup.sh
# Overrides:  DATA_FILE=… BACKUP_DIR=… ./backup.sh
# ============================================================
set -euo pipefail

DATA_FILE="${DATA_FILE:-/var/lib/calvo/data/availability.json}"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

die() { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

# backups land in the checkout owner's home, not root's (the timer runs as root)
OWNER="$(stat -c %U "$SRC_DIR" 2>/dev/null || stat -f %Su "$SRC_DIR")"
if [[ -z ${BACKUP_DIR:-} ]]; then
  OWNER_HOME="$(getent passwd "$OWNER" | cut -d: -f6)"
  [[ -n $OWNER_HOME ]] || die "cannot resolve home directory of user '$OWNER'"
  BACKUP_DIR="$OWNER_HOME/termin/data"
fi

[[ -f $DATA_FILE ]] || exit 0 # no votes yet — nothing to back up

if [[ ! -d $BACKUP_DIR ]]; then
  mkdir -p "$BACKUP_DIR"
  chmod 700 "$BACKUP_DIR"
fi

# snapshot first so the compare and the stored copy see the same bytes even
# if the server writes concurrently; a torn read fails the JSON check below
# and is simply retried on the next timer tick
tmp="$(mktemp "$BACKUP_DIR/.snapshot.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
cp "$DATA_FILE" "$tmp"
if command -v node > /dev/null; then
  node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$tmp" 2>/dev/null \
    || exit 0
fi

# skip when nothing changed since the newest backup (names sort by time)
latest="$(ls "$BACKUP_DIR"/availability-*.json 2>/dev/null | tail -1 || true)"
if [[ -n $latest ]] && cmp -s "$tmp" "$latest"; then
  exit 0
fi

dest="$BACKUP_DIR/availability-$(date +%Y%m%d-%H%M%S).json"
chmod 600 "$tmp"
mv "$tmp" "$dest"
[[ $EUID -eq 0 ]] && chown -R "$OWNER" "$BACKUP_DIR" || true
echo "backed up $DATA_FILE → $dest"
