#!/bin/bash
# ============================================================
# FluxSMS - Cloudflare Setup Script
# Execute: bash cloudflare/setup.sh
# Requerido: CF_API_TOKEN, CF_ZONE_ID e DOMAIN no ambiente
# ============================================================

CF_API="https://api.cloudflare.com/client/v4"
DOMAIN="${DOMAIN:-fluxsms.com.br}"
BACKEND_IP="${BACKEND_IP:-1.2.3.4}"  # IP do seu servidor backend
PAGES_CNAME="${PAGES_CNAME:-seu-user.github.io}"

echo "=== FluxSMS Cloudflare Setup ==="
echo "Domínio: $DOMAIN"

# ─── 1. Registros DNS ────────────────────────────────────────
echo "[1/4] Criando registros DNS..."

# Frontend (GitHub Pages)
curl -s -X POST "$CF_API/zones/$CF_ZONE_ID/dns_records" \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"type\":\"CNAME\",\"name\":\"@\",\"content\":\"$PAGES_CNAME\",\"proxied\":true}" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('  DNS @:', 'OK' if d['success'] else d['errors'])"

# www redirect
curl -s -X POST "$CF_API/zones/$CF_ZONE_ID/dns_records" \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"type\":\"CNAME\",\"name\":\"www\",\"content\":\"$DOMAIN\",\"proxied\":true}" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('  DNS www:', 'OK' if d['success'] else d['errors'])"

# Backend API subdomain
curl -s -X POST "$CF_API/zones/$CF_ZONE_ID/dns_records" \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"type\":\"A\",\"name\":\"api\",\"content\":\"$BACKEND_IP\",\"proxied\":true}" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('  DNS api:', 'OK' if d['success'] else d['errors'])"

# ─── 2. SSL/TLS: Full (Strict) ───────────────────────────────
echo "[2/4] Configurando SSL Full (Strict)..."
curl -s -X PATCH "$CF_API/zones/$CF_ZONE_ID/settings/ssl" \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"value":"full"}' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('  SSL:', 'OK' if d['success'] else d['errors'])"

# ─── 3. HTTPS sempre ─────────────────────────────────────────
echo "[3/4] Forçando HTTPS..."
curl -s -X PATCH "$CF_API/zones/$CF_ZONE_ID/settings/always_use_https" \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"value":"on"}' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('  HTTPS:', 'OK' if d['success'] else d['errors'])"

# ─── 4. Security Level ───────────────────────────────────────
echo "[4/4] Configurando segurança..."
curl -s -X PATCH "$CF_API/zones/$CF_ZONE_ID/settings/security_level" \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"value":"medium"}' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('  Security:', 'OK' if d['success'] else d['errors'])"

echo ""
echo "=== Setup Concluído! ==="
echo "Aguarde 5 minutos para propagação do DNS."
echo "Frontend: https://$DOMAIN"
echo "Backend:  https://api.$DOMAIN"
