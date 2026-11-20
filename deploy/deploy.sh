#!/usr/bin/env bash
# Build and (re)start the deployed Post Studio on the server, then check it (Phase 6).
#   deploy/deploy.sh            backup → build → up → health on loopback and through Traefik
#   deploy/deploy.sh --no-build restart with the current image
# Takes a backup of the live data first. Never prints secrets.
set -euo pipefail
here="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
compose=(docker compose -f "$here/deploy/compose.yaml")
domain="${POST_STUDIO_DOMAIN:-studio.example.com}"

if ss -ltnp 2>/dev/null | grep -q '127.0.0.1:3472 .*node' && ! docker inspect -f '{{.State.Running}}' post-studio >/dev/null 2>&1; then
  echo "a local 'pstudio serve' holds 127.0.0.1:3472; stop it first (the container takes that port)" >&2
  exit 1
fi
"$here/deploy/backup.sh" >/dev/null && echo "backup: ok"
if [ "${1:-}" != "--no-build" ]; then "${compose[@]}" build; fi
"${compose[@]}" up -d
for _ in $(seq 1 60); do curl -sf http://127.0.0.1:3472/v1/health >/dev/null && break; sleep 1; done
curl -sf http://127.0.0.1:3472/v1/health >/dev/null && echo "loopback: ok (http://127.0.0.1:3472)"
# Through Traefik on this host, independent of public DNS (-k: Traefik's default cert until Let's Encrypt has issued).
for _ in $(seq 1 20); do
  curl -skf --resolve "$domain:443:127.0.0.1" "https://$domain/v1/health" >/dev/null && { echo "traefik: ok (https://$domain)"; break; }
  sleep 1
done
if curl -sf -m 10 "https://$domain/v1/health" >/dev/null 2>&1; then echo "public https with a valid certificate: ok"
else echo "public https not verified yet (DNS record or certificate missing?)"; fi
