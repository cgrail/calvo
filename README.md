# calvo
Calendar Voting — finde einen Termin, an dem alle Zeit haben.

## Run locally

```bash
npm install
npm start          # http://localhost:3000
```

Optional env vars: `PORT` (default 3000), `HOST` (default all interfaces),
`DATA_DIR` (default `./data` — holds `availability.json`).

## Deployment

Calvo shares an Ubuntu box with [mech-vs-mech](https://github.com/cgrail/mech-vs-mech),
whose `install.sh` (run in Let's Encrypt mode, i.e. with `DOMAIN=…`) owns the OS
hardening, firewall, Node.js and Caddy. [install.sh](install.sh) here only adds
the app on top: a sandboxed systemd unit on `127.0.0.1:3000` plus a Caddy site
file, so calvo gets its own hostname with an auto-issued certificate.

On the server:

```bash
git clone https://github.com/cgrail/calvo.git && cd calvo
sudo ./install.sh                          # serves https://calvo.grails.de
sudo DOMAIN=cal.example.com ./install.sh   # different hostname
```

Then point a plain **un-proxied** A/AAAA record for the domain at the box.

- **Updates**: automatic — a systemd timer runs [update.sh](update.sh) every
  5 minutes and deploys whatever lands on `origin/main`. Manual: `sudo ./update.sh --force`.
- **Data**: `/var/lib/calvo/data/availability.json` — survives redeploys and restarts.
- **Backups**: a timer runs [backup.sh](backup.sh) every 5 minutes; whenever the data
  changed, a timestamped copy lands in `~/termin/data/availability-<timestamp>.json`
  (home of the user owning the server checkout).
- **Logs**: `journalctl -u calvo -f`
