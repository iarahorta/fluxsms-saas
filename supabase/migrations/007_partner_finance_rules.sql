-- ============================================================
-- FluxSMS - Migration 007: Regras financeiras parceiro (saque)
-- ============================================================

-- Prioridade admin: ignora prazos de carência nos cálculos do backend
ALTER TABLE public.partner_profiles
    ADD COLUMN IF NOT EXISTS saque_prioritario BOOLEAN NOT NULL DEFAULT FALSE;

-- Pedidos de saque (processamento manual / gateway futuro)
CREATE TABLE IF NOT EXISTS public.partner_withdrawal_requests (
    id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    partner_id       UUID NOT NULL REFERENCES public.partner_profiles(id) ON DELETE CASCADE,
    user_id          UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    amount           NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
    pix_destination  TEXT,
    status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'approved', 'rejected', 'paid')),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_partner_withdrawals_partner
    ON public.partner_withdrawal_requests (partner_id);
CREATE INDEX IF NOT EXISTS idx_partner_withdrawals_status
    ON public.partner_withdrawal_requests (partner_id, status);

DROP TRIGGER IF EXISTS trg_partner_withdrawals_updated_at ON public.partner_withdrawal_requests;
CREATE TRIGGER trg_partner_withdrawals_updated_at
    BEFORE UPDATE ON public.partner_withdrawal_requests
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.partner_withdrawal_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "partner_withdrawals_select_own_or_admin" ON public.partner_withdrawal_requests;
CREATE POLICY "partner_withdrawals_select_own_or_admin"
    ON public.partner_withdrawal_requests FOR SELECT
    USING (
        partner_id IN (SELECT id FROM public.partner_profiles WHERE user_id = auth.uid())
        OR public.is_flux_admin_by_profile()
    );

DROP POLICY IF EXISTS "partner_withdrawals_insert_own" ON public.partner_withdrawal_requests;
CREATE POLICY "partner_withdrawals_insert_own"
    ON public.partner_withdrawal_requests FOR INSERT
    WITH CHECK (
        partner_id IN (SELECT id FROM public.partner_profiles WHERE user_id = auth.uid())
        AND user_id = auth.uid()
    );

DROP POLICY IF EXISTS "partner_withdrawals_admin_all" ON public.partner_withdrawal_requests;
CREATE POLICY "partner_withdrawals_admin_all"
    ON public.partner_withdrawal_requests FOR ALL
    USING (public.is_flux_admin_by_profile())
    WITH CHECK (public.is_flux_admin_by_profile());

-- RPC parceiro: expõe flag de prioridade (UI)
CREATE OR REPLACE FUNCTION public.rpc_partner_get_my_profile()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_rec RECORD;
BEGIN
    SELECT pp.*, p.email
    INTO v_rec
    FROM public.partner_profiles pp
    JOIN public.profiles p ON p.id = pp.user_id
    WHERE pp.user_id = auth.uid();

    IF v_rec IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'partner_nao_configurado');
    END IF;

    RETURN jsonb_build_object(
        'ok', true,
        'partner_id', v_rec.id,
        'partner_code', v_rec.partner_code,
        'status', v_rec.status,
        'margin_percent', v_rec.margin_percent,
        'email', v_rec.email,
        'saque_prioritario', COALESCE(v_rec.saque_prioritario, false),
        'partner_created_at', v_rec.created_at
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_partner_get_my_profile() TO authenticated;
