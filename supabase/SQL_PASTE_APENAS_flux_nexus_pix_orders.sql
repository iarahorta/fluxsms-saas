-- Cole no Supabase SQL Editor (resolve: PGRST205 / tabela public.flux_nexus_pix_orders em falta).
-- Idempotente. Não altera outras tabelas.

CREATE TABLE IF NOT EXISTS public.flux_nexus_pix_orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    amount_brl NUMERIC(12, 2) NOT NULL,
    external_ref TEXT NOT NULL UNIQUE,
    gateway_charge_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'failed', 'expired')),
    raw_create JSONB NOT NULL DEFAULT '{}'::jsonb,
    raw_webhook JSONB NOT NULL DEFAULT '{}'::jsonb,
    paid_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_flux_nexus_pix_orders_user_id
    ON public.flux_nexus_pix_orders (user_id);

CREATE INDEX IF NOT EXISTS ix_flux_nexus_pix_orders_status
    ON public.flux_nexus_pix_orders (status, created_at DESC);

-- Forçar o PostgREST a recarregar o cache do schema (se o Studio ainda não “vê” a tabela):
NOTIFY pgrst, 'reload schema';
