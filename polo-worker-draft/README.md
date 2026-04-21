# FluxSMS — Rascunho: Executável de Polo (Electron + Node)

Objetivo: app de secretária no PC do parceiro que:

1. Guarda a **Partner API Key** (uma vez ou até limpar).
2. Lista portas **COM** (`serialport`).
3. Regista o chip no servidor: `POST /partner-api/chips` (já existente no backend FluxSMS).
4. Mantém o polo **ONLINE** e escuta pedidos: `POST /partner-api/worker/heartbeat` + `GET /partner-api/worker/activations?polo_chave=...` (rotas adicionadas em `routes/partnerApi.js`).

## Requisitos

- Node 20+
- Windows: ao instalar `serialport`, pode ser necessário `npm install` e depois `npx @electron/rebuild` para recompilar o addon nativo contra a versão do Electron.

## Configuração

| Campo | Descrição |
|--------|------------|
| **URL do backend** | Ex.: `https://fluxsms-staging-production.up.railway.app` |
| **Partner API Key** | Chave criada em `partner_api_keys` (hash no banco; guardar o valor só no cliente). |
| **Chave do polo** | `polos.chave_acesso` — o polo deve ter `partner_profile_id` = ao parceiro dono da key. |
| **HARDWARE_API_KEY** | Usada só em `POST /sms/deliver` quando o modem lê o SMS (rota atual do servidor). *Rascunho:* tratar como segundo segredo local até existir entrega autenticada pela Partner key. |

## Scripts

```bash
cd polo-worker-draft
npm install
npm start
```

## Gerar `.exe` (Windows x64 portable)

```bash
npm install
npx @electron/rebuild
npm run dist
```

O executável sai em **`polo-worker-draft/dist-exe/`**. Manual em **`MANUAL_PT.md`** (3 passos).

## Manual CEO

Ver **`MANUAL_PT.md`**: baixar / gerar chave / conectar chip.

## Próximos passos (produção)

- Ler SMS real pela porta COM (parser por modem).
- Opcional: **Supabase Realtime** em vez de polling (service role não vai no cliente; manter polling ou Edge Function).
- Unificar autenticação de `POST /sms/deliver` com o modelo Partner/Polo (hoje é `HARDWARE_API_KEY` global).
