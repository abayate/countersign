#!/bin/bash
# Paste as the startup script of a Vultr Ubuntu instance (or run it over SSH as root).
# Set REPO and DOMAIN first, and point the domain's A record at the instance IP.
set -euo pipefail
REPO="${REPO:?git URL of the Countersign repo}"
DOMAIN="${DOMAIN:?domain that points at this server}"
curl -fsSL https://get.docker.com | sh
git clone "$REPO" /opt/countersign
cd /opt/countersign
[ -f .env ] || cp .env.example .env   # then edit /opt/countersign/.env with real keys and re-run compose
DOMAIN="$DOMAIN" docker compose -f deploy/docker-compose.yml up -d --build
ufw allow 80,443/tcp || true
