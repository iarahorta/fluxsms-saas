# FluxSMS — Guia de Integração MCP + Mercado Pago

## O que é o MCP Server?

O **Mercado Pago MCP Server** permite que a IA (Antigravity/Cursor) acesse
sua conta do Mercado Pago diretamente, para configurar webhooks, consultar
pagamentos e validar integrações sem você precisar acessar o painel manualmente.

---

## Passo 1: Conectar o MCP ao seu editor

### Opção A: Cursor (Recomendado)

O arquivo `.cursor/mcp.json` já está configurado. Só precisa:

1. Abrir o Cursor nesta pasta (`FLUXSMS-projeto`)
2. Pressionar `Ctrl+Shift+J` → **Features → MCP**
3. Verificar se **mercadopago** aparece na lista
4. Clicar em **Connect**
5. Quando pedir o Access Token, cole o seu `APP_USR-...`

### Opção B: VS Code

O arquivo `.vscode/mcp.json` já está configurado. O VS Code vai pedir
o Access Token de forma segura (campo senha).

---

## Passo 2: Obter seus tokens no Mercado Pago

1. Acesse: https://www.mercadopago.com.br/developers/panel/app
2. Crie ou selecione sua aplicação FluxSMS
3. Copie o **Access Token de Produção** (começa com `APP_USR-`)

> ⚠️ **NUNCA coloque o Access Token no código!**
> Use sempre GitHub Secrets ou variável de ambiente.

---

## Passo 3: Configurar Webhook automaticamente

Com o MCP conectado, basta pedir ao assistente:

```
"Configure o webhook do Mercado Pago para apontar para https://api.fluxsms.com.br/webhook/mercadopago"
```

Ou execute o script manualmente:

```powershell
# No terminal PowerShell:
$env:MP_ACCESS_TOKEN = "APP_USR-SEU-TOKEN-AQUI"
$env:BACKEND_URL = "https://api.fluxsms.com.br"
node configure-mp-webhook.js
```

---

## Passo 4: Testar o fluxo completo

### 4.1 Simular pagamento aprovado (ambiente de teste)

Use o Access Token de **sandbox** (começa com `TEST-`):

```powershell
$env:MP_ACCESS_TOKEN = "TEST-SEU-TOKEN-SANDBOX"
$env:BACKEND_URL = "https://api.fluxsms.com.br"
node configure-mp-webhook.js
```

### 4.2 Verificar se o saldo foi creditado

Via Supabase Studio ou com a IA:
```sql
SELECT id, email, balance FROM profiles WHERE id = 'seu-user-id';
```

---

## Fluxo completo de pagamento Pix

```
[Usuário clica "Recarregar" no frontend]
         ↓
[Frontend chama POST /webhook/criar-pix com valor]
         ↓
[Backend gera payment no MP com user_id no metadata]
         ↓
[Returns: qr_code + qr_code_base64]
         ↓
[Usuário paga o Pix no app do banco]
         ↓
[Mercado Pago envia notificação para /webhook/mercadopago]
         ↓
[Backend valida payment_id na API oficial do MP]
         ↓
[Chama rpc_creditar_saldo() no Supabase]
         ↓
[Saldo atualizado no banco com idempotência]
         ↓
[Frontend recebe via Supabase Realtime (opcional)]
```

---

## Ferramentas disponíveis via MCP

Quando conectado, você pode pedir à IA:

| Comando em linguagem natural | O que faz |
|---|---|
| "Liste todos os pagamentos aprovados hoje" | Consulta API do MP |
| "Configure o webhook para apontar para X" | Cria/atualiza webhook |
| "Valide se o payment ID 123 foi aprovado" | Verifica status |
| "Mostre minha aplicação FluxSMS" | Lista configurações do app |
| "Crie um QR Code de R$ 50 para teste" | Gera pagamento sandbox |

---

## GitHub Secrets necessários

| Secret | Valor |
|---|---|
| `MP_ACCESS_TOKEN` | `APP_USR-...` (produção) |
| `SUPABASE_URL` | `https://xxx.supabase.co` |
| `SUPABASE_SERVICE_KEY` | `eyJ...` (service_role) |
| `SUPABASE_ANON_KEY` | `eyJ...` (anon) |
| `HARDWARE_API_KEY` | Chave secreta para o modem |
| `RAILWAY_TOKEN` | Token do Railway (backend) |
