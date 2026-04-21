# FluxSMS Polo Worker — Manual (3 passos)

Versão alinhada ao **Staging** após deploy do backend (`/partner-api/worker/*`) e do painel com **Gerar API Key**.

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

## 2) Como gerar a chave

1. Entrar no **site FluxSMS** com conta **admin** (Iara).
2. **Opção A — Dashboard:** menu **Parceiros API** → na linha do parceiro, botão **Gerar API Key** → copiar a chave do prompt (só aparece uma vez).  
3. **Opção B — Admin Hub:** `…/admindiretoria/index.html` → secção **Parceiros — Partner API Key** → **Gerar API Key** → copiar do prompt.
4. A equipa de sistema garante que o **polo** está ligado a esse parceiro no cadastro (campo de vínculo ao `partner_profile`), para o worker conseguir registar chips e heartbeat — sem a CEO executar SQL.

---

## 3) Como conectar o chip

1. Abrir o **.exe** no PC do polo.
2. Colar **URL do backend**, **Partner API Key**, **chave do polo** (`chave_acesso`), e **HARDWARE_API_KEY** (para enviar SMS recebido ao `POST /sms/deliver`).
3. **Listar portas** → escolher COM do modem → preencher **número do chip** → **Enviar para API** (registo em `chips`).
4. Clicar **Iniciar escuta** (heartbeat + fila `waiting`). Quando o modem ler o código SMS, usar **Entregar SMS** com `activation_id` da fila (ou automatizar no passo seguinte de produto).

---

**Suporte:** documentação JSON em `GET /partner-api/docs` no servidor.
