# FluxSMS Polo Worker — Manual (3 passos)

Versão alinhada ao **Staging** após deploy do backend (`/partner-api/worker/*`), chave **única** no cadastro parceiro e trava **HWID** (header `X-Flux-Hwid` enviado automaticamente pelo `.exe`).

---

## 1) Como baixar

1. No repositório, pasta **`polo-worker-draft`** (ou artefacto gerado na CI).
2. **Programador / TI:** na máquina Windows, com Node 20+:
   - `cd polo-worker-draft`
   - `npm install`
   - `npx @electron/rebuild` (se `serialport` reclamar com Electron)
   - `npm run dist` → ficheiro **portable** `.exe` em `dist-exe/` (nome tipo `FluxSMS Polo Worker 0.1.0.exe`).
3. Enviar esse **.exe** à operação (CEO não precisa compilar).

---

## 2) Chave Partner (identidade fixa)

1. **Parceiro novo:** abrir **`/partner/register`**, criar conta — a **Partner API Key** aparece **uma vez** no prompt; guarde-a. A mesma chave fica no painel (revelar/copiar) e **liga-se ao primeiro PC** que usar o Worker com ela.
2. **Rotação / legado:** apenas **admin** (Dashboard ou Admin Hub) pode **Gerar API Key** para substituir a chave e libertar um novo vínculo HWID.
3. A equipa de sistema garante que o **polo** está ligado a esse parceiro no cadastro (`partner_profile_id`), para o worker registar chips e heartbeat.

---

## 3) Como conectar o chip

1. Abrir o **.exe** no PC do polo.
2. Colar **URL do backend**, **Partner API Key**, **chave do polo** (`chave_acesso`), e **HARDWARE_API_KEY** (para enviar SMS recebido ao `POST /sms/deliver`).
3. **Listar portas** → escolher COM do modem → preencher **número do chip** → **Enviar para API** (registo em `chips`).
4. Clicar **Iniciar escuta** (heartbeat + fila `waiting`). Quando o modem ler o código SMS, usar **Entregar SMS** com `activation_id` da fila (ou automatizar no passo seguinte de produto).

---

**Suporte:** documentação JSON em `GET /partner-api/docs` no servidor.
