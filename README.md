# FluxSMS — Estrutura Completa 🚀
![Deployment Status](https://img.shields.io/badge/Status-Online-gold?style=for-the-badge)

**SaaS de recebimento de SMS com chips físicos reais**

---

## 📁 Estrutura do Projeto

```
FLUXSMS-projeto/
├── .github/workflows/main.yml      → CI/CD: deploy automático no push
├── supabase/migrations/
│   ├── 001_tables.sql              → Todas as tabelas
│   ├── 002_rls.sql                 → Row Level Security
│   └── 003_functions.sql           → RPC (controle de saldo seguro)
├── backend/
│   ├── server.js                   → Express + Helmet + CORS
│   ├── routes/webhook.js           → Webhook Mercado Pago
│   ├── routes/sms.js               → Entrega SMS + Mock (protegido)
│   ├── middleware/rateLimit.js     → Rate limiting
│   ├── middleware/validate.js      → Sanitização de inputs
│   └── package.json
├── cloudflare/setup.sh             → Configura DNS + SSL via API
├── assets/logo.png                 → Logo transparente
├── assets/icon.png                 → Favicon
├── index.html                      → Frontend SaaS
├── style.css                       → Estilo Black & Gold
├── app.js                          → Lógica frontend + Realtime
├── .env.example                    → Template de secrets
├── .gitignore
└── README.md
```

---

## 🚀 Como Fazer o Deploy

### 1. GitHub Secrets
Configure em `Settings → Secrets → Actions`:
- Copie cada variável do `.env.example` e preencha

### 2. Push para o branch `main`
```bash
git add .
git commit -m "chore: initial deploy"
git push origin main
```
O GitHub Actions faz todo o resto automaticamente.

### 3. Cloudflare (uma vez só)
```bash
export CF_API_TOKEN=seu_token
export CF_ZONE_ID=seu_zone_id
export DOMAIN=fluxsms.com.br
bash cloudflare/setup.sh
```

---

## 🔐 Segurança

| Camada | Proteção |
|--------|----------|
| **RLS Supabase** | Usuário só vê seus próprios dados |
| **RPC Functions** | Saldo nunca é alterado diretamente pelo frontend |
| **Race Condition** | `FOR UPDATE SKIP LOCKED` no PostgreSQL |
| **Webhook MP** | Valida `payment_id` na API oficial antes de creditar |
| **Hardware API** | `HARDWARE_API_KEY` protegida em GitHub Secrets |
| **Rate Limiting** | 100 req/min geral, 10 req/min para SMS |
| **Cloudflare** | SSL Full Strict + DDoS protection |

---

## 📡 Realtime (SMS em tempo real)

O frontend usa o Supabase Realtime para receber o código assim que o modem entrega:

```javascript
supabase
  .channel('activation:' + activationId)
  .on('postgres_changes', { event: 'UPDATE', table: 'activations', filter: `id=eq.${activationId}` },
    (payload) => {
      if (payload.new.sms_code) exibirCodigo(payload.new.sms_code);
    })
  .subscribe();
```

---

## 🔑 GitHub Secrets Necessários

Ver `.env.example` para a lista completa.
