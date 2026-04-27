# Checkpoint — retomar depois (2026-04-28)

## Última checagem automática (agente)

- `node --check` em `server.js`, `middleware/partnerAuth.js`, `routes/sms.js`, `routes/partnerApi.js`: **OK**
- `node scripts/verify-fluxsms-rpc-contract.js`: **OK**
- `node --check` em `polo-worker-draft/src/main.js` e `renderer.js`: **OK**
- Produção: `GET https://fluxsms.com.br/partner-api/docs` → `ok: true`; Railway deploy **SUCCESS** no commit da `main`.

## Onde estávamos (resumo)

- **Login parceiro / EXE:** corrigidos (PostgREST `expires_at` no `partnerAuth`, chave sempre via `/partner-api/auth/login` no desktop, etc.).
- **SMS entrega (`POST /sms/deliver`):** teste HTTPS com Partner API key → **`ok: true`** na primeira chamada; segunda com o mesmo `activation_id` → `activation_not_waiting` (esperado após `received`).
- **Script PowerShell (sem COM):** `polo-worker-draft/scripts/Test-SmsDeliver.ps1`

## Pendente só contigo (SMS físico)

- Novo `activation_id` em **`waiting`** → teste real modem / EXE → confirmação no painel cliente + Supabase.
- **Rotação da Partner API key** após fim dos testes (chave exposta no chat).

## Cadastro público parceiro — FECHADO (2026-04-28)

- **API:** `POST /api/partner/onboarding/activate` devolve **403** `public_registration_disabled` salvo `PUBLIC_PARTNER_REGISTER=1` no Railway.
- **UI:** `partner-login.html` (link cadastro), `partner-landing.html` (Cadastrar), `partner-register.html` (página “Em breve” + login). Ver `.env.example` para a variável.

## SQL útil

- Listar `waiting`: `select id, status, service from public.activations where status = 'waiting' order by created_at desc limit 10;`
- Ver uma ativação: `select id, status, sms_code, updated_at from public.activations where id = '<uuid>';`
- Limpeza utilizadores: `supabase/scripts/cleanup_users_hard_delete.sql`

## Transcript Cursor

`C:\Users\user\.cursor\projects\c-Users-user-Desktop-Export-GSM-Codder\agent-transcripts\`

## Repo / Git

- **Stash:** `git stash list` — entrada `WIP 2026-04-28 alteracoes tracked ao sair` (rever antes de `stash pop`).
- **Branch backup remota:** `backup/checkpoint-2026-04-28-pre-wip`
- **Untracked** (`.railway-deploy/` duplicado, `.exe`, etc.): não entram no stash; `git status`.
