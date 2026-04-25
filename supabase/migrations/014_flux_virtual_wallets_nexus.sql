-- FluxSMS — Carteiras virtuais + pedidos PIX (NexusPag / compatível)
-- NOTA: execute no Supabase (ou via CLI). Não armazene API keys aqui.

-- 1) Carteiras virtuais (saldo contábil interno)
CREATE TABLE IF NOT EXISTS public.virtual_wallets (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    slug TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    balance NUMERIC(14, 2) NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_virtual_wallets_updated_at
    BEFORE UPDATE ON public.virtual_wallets
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 2) Razão / auditoria
CREATE TABLE IF NOT EXISTS public.virtual_wallet_ledger (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    wallet_id UUID NOT NULL REFERENCES public.virtual_wallets(id) ON DELETE CASCADE,
    amount NUMERIC(14, 2) NOT NULL,
    ref_type TEXT NOT NULL,
    ref_id TEXT,
    meta JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_virtual_wallet_ledger_ref
    ON public.virtual_wallet_ledger (ref_type, ref_id)
    WHERE ref_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_virtual_wallet_ledger_wallet_created
    ON public.virtual_wallet_ledger (wallet_id, created_at DESC);

-- 3) Pedidos de depósito PIX (NexusPag)
CREATE TABLE IF NOT EXISTS public.flux_nexus_pix_orders (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
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

CREATE TRIGGER trg_flux_nexus_pix_orders_updated_at
    BEFORE UPDATE ON public.flux_nexus_pix_orders
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 4) Transações: suportar gateway além do Mercado Pago
ALTER TABLE public.transactions
    ADD COLUMN IF NOT EXISTS gateway TEXT,
    ADD COLUMN IF NOT EXISTS external_payment_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS ux_transactions_external_gateway
    ON public.transactions (gateway, external_payment_id)
    WHERE gateway IS NOT NULL AND external_payment_id IS NOT NULL;

-- 5) Chips: bloqueio por serviço (ex.: WhatsApp “queimado”, outros serviços seguem)
ALTER TABLE public.chips
    ADD COLUMN IF NOT EXISTS chip_service_off JSONB NOT NULL DEFAULT '{}'::jsonb;

-- 6) Seeds padrão (nomes amigáveis para auditoria no Admin)
INSERT INTO public.virtual_wallets (slug, display_name)
VALUES
    ('LUCRO_SOCIO', 'Lucro Sócio (Ju)'),
    ('LUCRO_JORSIA', 'Lucro Jorsia'),
    ('LUCRO_IARA', 'Lucro Iara'),
    ('CAIXA_CHIP', 'Caixa Chip (equipamento)')
ON CONFLICT (slug) DO NOTHING;

-- 7) RPC atômica: creditar carteira + ledger (idempotente por ref_type/ref_id)
CREATE OR REPLACE FUNCTION public.rpc_flux_wallet_credit(
    p_slug TEXT,
    p_amount NUMERIC,
    p_ref_type TEXT,
    p_ref_id TEXT,
    p_meta JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_wallet_id UUID;
    v_exists BOOLEAN;
BEGIN
    IF p_amount IS NULL OR p_amount <= 0 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'invalid_amount');
    END IF;

    IF p_ref_type IS NOT NULL AND p_ref_id IS NOT NULL THEN
        SELECT EXISTS(
            SELECT 1 FROM public.virtual_wallet_ledger
            WHERE ref_type = p_ref_type AND ref_id = p_ref_id
        ) INTO v_exists;
        IF v_exists THEN
            RETURN jsonb_build_object('ok', true, 'skipped', true, 'reason', 'already_credited');
        END IF;
    END IF;

    SELECT id INTO v_wallet_id
    FROM public.virtual_wallets
    WHERE slug = p_slug
    LIMIT 1;

    IF v_wallet_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'wallet_not_found', 'slug', p_slug);
    END IF;

    UPDATE public.virtual_wallets
    SET balance = balance + p_amount
    WHERE id = v_wallet_id;

    INSERT INTO public.virtual_wallet_ledger (wallet_id, amount, ref_type, ref_id, meta)
    VALUES (v_wallet_id, p_amount, COALESCE(p_ref_type, 'misc'), p_ref_id, COALESCE(p_meta, '{}'::jsonb));

    RETURN jsonb_build_object('ok', true, 'slug', p_slug, 'amount', p_amount);
END;
$$;

-- 8) Crédito de saldo do cliente (PIX Nexus) — espelha rpc_creditar_saldo, com gateway genérico
CREATE OR REPLACE FUNCTION public.rpc_creditar_saldo_gateway(
    p_user_id UUID,
    p_amount NUMERIC,
    p_external_payment_id TEXT,
    p_payment_status TEXT,
    p_gateway TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_already BOOLEAN;
BEGIN
    IF p_external_payment_id IS NULL OR btrim(p_external_payment_id) = '' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'missing_external_payment_id');
    END IF;

    SELECT EXISTS(
        SELECT 1 FROM public.transactions
        WHERE gateway = p_gateway
          AND external_payment_id = p_external_payment_id
    ) INTO v_already;

    IF v_already THEN
        RETURN jsonb_build_object('ok', false, 'error', 'pagamento_ja_processado');
    END IF;

    IF lower(coalesce(p_payment_status, '')) NOT IN ('approved', 'paid', 'completed', 'confirmed') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'pagamento_nao_aprovado', 'status', p_payment_status);
    END IF;

    UPDATE public.profiles SET balance = balance + p_amount WHERE id = p_user_id;

    INSERT INTO public.transactions (
        user_id, type, amount, description,
        mp_payment_id, mp_status,
        gateway, external_payment_id
    )
    VALUES (
        p_user_id, 'credit', p_amount, 'Recarga via PIX (' || coalesce(p_gateway, 'gateway') || ')',
        NULL, NULL,
        p_gateway, p_external_payment_id
    );

    RETURN jsonb_build_object('ok', true, 'amount_credited', p_amount);
END;
$$;
