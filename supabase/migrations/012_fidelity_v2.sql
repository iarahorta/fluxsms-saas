-- ============================================================
-- FluxSMS 012: Fidelidade semanal + nível permanente (high ticket)
-- ============================================================

ALTER TABLE public.profiles
    ADD COLUMN IF NOT EXISTS fidelity_level TEXT NOT NULL DEFAULT 'BRONZE',
    ADD COLUMN IF NOT EXISTS fidelity_level_permanent TEXT,
    ADD COLUMN IF NOT EXISTS fidelity_weekly_total NUMERIC(10, 2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS fidelity_last_deposit_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS fidelity_next_review_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS fidelity_has_premium_access BOOLEAN NOT NULL DEFAULT FALSE;

CREATE OR REPLACE FUNCTION public.rpc_refresh_fidelity_level(p_user_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_weekly_total NUMERIC(10, 2) := 0;
    v_max_single NUMERIC(10, 2) := 0;
    v_last_credit TIMESTAMPTZ;
    v_weekly_level TEXT := 'BRONZE';
    v_permanent_level TEXT := NULL;
    v_effective_level TEXT := 'BRONZE';
    v_discount NUMERIC := 0;
BEGIN
    SELECT
        COALESCE(SUM(CASE WHEN t.created_at >= NOW() - INTERVAL '7 days' THEN t.amount ELSE 0 END), 0),
        COALESCE(MAX(t.amount), 0),
        MAX(t.created_at)
    INTO v_weekly_total, v_max_single, v_last_credit
    FROM public.transactions t
    WHERE t.user_id = p_user_id
      AND t.type = 'credit';

    IF v_weekly_total >= 3000 THEN
        v_weekly_level := 'DIAMANTE';
    ELSIF v_weekly_total >= 1000 THEN
        v_weekly_level := 'OURO';
    ELSIF v_weekly_total >= 200 THEN
        v_weekly_level := 'PRATA';
    ELSIF v_weekly_total >= 20 THEN
        v_weekly_level := 'BRONZE';
    END IF;

    IF v_max_single >= 30000 THEN
        v_permanent_level := 'DIAMANTE';
    ELSIF v_max_single >= 10000 THEN
        v_permanent_level := 'OURO';
    ELSIF v_max_single >= 5000 THEN
        v_permanent_level := 'PRATA';
    END IF;

    v_effective_level := v_weekly_level;
    IF v_permanent_level = 'DIAMANTE' THEN
        v_effective_level := 'DIAMANTE';
    ELSIF v_permanent_level = 'OURO' AND v_effective_level IN ('BRONZE', 'PRATA') THEN
        v_effective_level := 'OURO';
    ELSIF v_permanent_level = 'PRATA' AND v_effective_level = 'BRONZE' THEN
        v_effective_level := 'PRATA';
    END IF;

    IF v_effective_level = 'DIAMANTE' THEN
        v_discount := 0.20;
    END IF;

    UPDATE public.profiles
    SET fidelity_level = v_effective_level,
        fidelity_level_permanent = v_permanent_level,
        fidelity_weekly_total = v_weekly_total,
        fidelity_last_deposit_at = v_last_credit,
        fidelity_next_review_at = CASE WHEN v_last_credit IS NULL THEN NULL ELSE (v_last_credit + INTERVAL '7 days') END,
        fidelity_has_premium_access = (v_effective_level = 'DIAMANTE')
    WHERE id = p_user_id;

    RETURN jsonb_build_object(
        'ok', true,
        'level', v_effective_level,
        'permanent_level', v_permanent_level,
        'weekly_total', v_weekly_total,
        'discount', v_discount
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_refresh_fidelity_level(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_refresh_fidelity_level(UUID) TO service_role;
