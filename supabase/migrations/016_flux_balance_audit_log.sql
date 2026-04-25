-- Auditoria interna: movimentações de saldo / gateway (sem exposição pública)
-- Acesso apenas via SERVICE_ROLE no backend (RLS nega leitura anónima/autenticada).

CREATE TABLE IF NOT EXISTS public.flux_balance_audit_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    event_type TEXT NOT NULL,
    gateway TEXT,
    external_ref TEXT,
    beneficiary_user_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    amount NUMERIC(14, 2) NOT NULL,
    currency TEXT NOT NULL DEFAULT 'BRL',
    partner_profile_id UUID REFERENCES public.partner_profiles(id) ON DELETE SET NULL,
    partner_api_key_id UUID REFERENCES public.partner_api_keys(id) ON DELETE SET NULL,
    partner_api_key_prefix TEXT,
    actor_ip TEXT,
    user_agent TEXT,
    meta JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS ix_flux_balance_audit_created
    ON public.flux_balance_audit_log (created_at DESC);

CREATE INDEX IF NOT EXISTS ix_flux_balance_audit_user
    ON public.flux_balance_audit_log (beneficiary_user_id, created_at DESC);

ALTER TABLE public.flux_balance_audit_log ENABLE ROW LEVEL SECURITY;

-- Sem políticas SELECT/INSERT para roles autenticados: apenas service_role (bypass) no Node.
