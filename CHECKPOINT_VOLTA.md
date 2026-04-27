# Checkpoint — retomar depois (2026-04-28)

## Onde estávamos (resumo)

- **Login parceiro / EXE:** corrigidos (PostgREST `expires_at` no `partnerAuth`, chave sempre via `/partner-api/auth/login` no desktop, etc.).
- **SMS entrega (`POST /sms/deliver`):** teste HTTPS no PC do utilizador com **Partner API key** → primeira chamada **`ok: true`** na ativação `ebd2688d-c06c-4757-bcaa-6a59558fb779`; segunda chamada com o **mesmo** `activation_id` → `activation_not_waiting` (normal: já estava `received`).
- **Script PowerShell (sem porta COM):** `polo-worker-draft/scripts/Test-SmsDeliver.ps1` — instruções no cabeçalho do ficheiro (ExecutionPolicy, one-liner, caminho do PC).

## Próximos passos quando voltares

1. **Rotação de chave:** a Partner API key foi exposta no chat — **revogar / gerar nova** no fim dos testes (combinado contigo).
2. **Testes modem / EXE:** novo pedido em `activations.status = 'waiting'` → novo `activation_id` → repetir `Test-SmsDeliver.ps1` ou one-liner; confirmar UI cliente + realtime.
3. **Opcional pós-testes (não feito ainda):** pop-up **“EM BREVE”** no portal parceiro e bloquear cadastro público (`/partner/register`) — ficou explicitamente **para depois** dos testes.

## SQL útil

- Listar `waiting`: `select id, status, service from public.activations where status = 'waiting' order by created_at desc limit 10;`
- Ver uma ativação: `select id, status, sms_code, updated_at from public.activations where id = '<uuid>';`
- Limpeza utilizadores (já no repo): `supabase/scripts/cleanup_users_hard_delete.sql`

## Transcript desta conversa (Cursor)

`C:\Users\user\.cursor\projects\c-Users-user-Desktop-Export-GSM-Codder\agent-transcripts\` — ficheiros `.jsonl` por sessão (procura por data / “SMS” / “partner”).

## Repo / branch

- Repositório local: `Export_GSM_Codder\FLUXSMS-projeto`
- Após este checkpoint: ver `git log -1` e, se existir, `git stash list` para entradas `WIP backup 2026-04-28`.
