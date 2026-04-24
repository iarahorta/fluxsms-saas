-- ============================================================
-- FluxSMS - Migration 004: Partner Module + API Security
-- ============================================================

-- Flag de parceiro no perfil principal
ALTER TABLE public.profiles
    ADD COLUMN IF NOT EXISTS is_partner BOOLEAN NOT NULL DEFAULT FALSE;

-- Plano de comissão/margem do parceiro
CREATE TABLE IF NOT EXISTS public.partner_profiles (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id             UUID NOT NULL UNIQUE REFERENCES public.profiles(id) ON DELETE CASCADE,
    partner_code        TEXT NOT NULL UNIQUE,
    status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
    margin_percent      NUMERIC(5,2) NOT NULL DEFAULT 0.00 CHECK (margin_percent >= 0 AND margin_percent <= 100),
    custom_commission   INTEGER,
    notes               TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- API keys do parceiro (hash no banco, nunca texto puro)
CREATE TABLE IF NOT EXISTS public.partner_api_keys (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    partner_id          UUID NOT NULL REFERENCES public.partner_profiles(id) ON DELETE CASCADE,
    key_hash            TEXT NOT NULL UNIQUE,
    key_prefix          TEXT NOT NULL,
    label               TEXT,
    is_active           BOOLEAN NOT NULL DEFAULT TRUE,
    last_used_at        TIMESTAMPTZ,
    expires_at          TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Allow list de IPs por parceiro (IP único ou CIDR)
CREATE TABLE IF NOT EXISTS public.partner_ip_allowlist (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    partner_id          UUID NOT NULL REFERENCES public.partner_profiles(id) ON DELETE CASCADE,
    ip_or_cidr          TEXT NOT NULL,
    label               TEXT,
    is_active           BOOLEAN NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(partner_id, ip_or_cidr)
);

-- Preço de custo por serviço para parceiro
CREATE TABLE IF NOT EXISTS public.partner_service_costs (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    partner_id          UUID NOT NULL REFERENCES public.partner_profiles(id) ON DELETE CASCADE,
    service             TEXT NOT NULL,
    cost_price          NUMERIC(10,2) NOT NULL CHECK (cost_price >= 0),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(partner_id, service)
);

CREATE OR REPLACE FUNCTION public.set_partner_code_from_email(p_email TEXT)
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
    v_base TEXT;
BEGIN
    v_base := regexp_replace(split_part(lower(coalesce(p_email, 'partner')), '@', 1), '[^a-z0-9]', '', 'g');
    IF length(v_base) < 3 THEN
        v_base := 'partner';
    END IF;
    RETURN left(v_base, 10) || '_' || substr(replace(uuid_generate_v4()::text, '-', ''), 1, 6);
END;
$$;

-- Helper de admin usando profiles.is_admin (compatível com base antiga)
CREATE OR REPLACE FUNCTION public.is_flux_admin_by_profile()
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_admin BOOLEAN := FALSE;
BEGIN
    SELECT is_admin INTO v_admin
    FROM public.profiles
    WHERE id = auth.uid();
    RETURN COALESCE(v_admin, FALSE);
END;
$$;

-- RPC: marcar/desmarcar parceiro
CREATE OR REPLACE FUNCTION public.rpc_admin_set_partner_status(
    p_user_id UUID,
    p_is_partner BOOLEAN,
    p_margin_percent NUMERIC DEFAULT 0,
    p_notes TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_email TEXT;
    v_partner_id UUID;
BEGIN
    IF NOT is_flux_admin_by_profile() THEN
        RETURN jsonb_build_object('ok', false, 'error', 'unauthorized');
    END IF;

    SELECT email INTO v_email FROM public.profiles WHERE id = p_user_id;
    IF v_email IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'usuario_nao_encontrado');
    END IF;

    UPDATE public.profiles
    SET is_partner = p_is_partner
    WHERE id = p_user_id;

    IF p_is_partner THEN
        INSERT INTO public.partner_profiles (user_id, partner_code, margin_percent, notes)
        VALUES (p_user_id, set_partner_code_from_email(v_email), COALESCE(p_margin_percent, 0), p_notes)
        ON CONFLICT (user_id) DO UPDATE
        SET status = 'active',
            margin_percent = COALESCE(EXCLUDED.margin_percent, public.partner_profiles.margin_percent),
            notes = COALESCE(EXCLUDED.notes, public.partner_profiles.notes),
            updated_at = NOW()
        RETURNING id INTO v_partner_id;
    ELSE
        UPDATE public.partner_profiles
        SET status = 'suspended', updated_at = NOW()
        WHERE user_id = p_user_id
        RETURNING id INTO v_partner_id;
    END IF;

    RETURN jsonb_build_object('ok', true, 'partner_id', v_partner_id, 'is_partner', p_is_partner);
END;
$$;

-- RPC: parceiro consulta seus dados
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
        'email', v_rec.email
    );
END;
$$;

-- updated_at automático nas tabelas partner
DROP TRIGGER IF EXISTS trg_partner_profiles_updated_at ON public.partner_profiles;
CREATE TRIGGER trg_partner_profiles_updated_at
    BEFORE UPDATE ON public.partner_profiles
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_partner_service_costs_updated_at ON public.partner_service_costs;
CREATE TRIGGER trg_partner_service_costs_updated_at
    BEFORE UPDATE ON public.partner_service_costs
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS
ALTER TABLE public.partner_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partner_api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partner_ip_allowlist ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partner_service_costs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "partner_profiles_select_own_or_admin" ON public.partner_profiles;
CREATE POLICY "partner_profiles_select_own_or_admin"
    ON public.partner_profiles FOR SELECT
    USING (user_id = auth.uid() OR is_flux_admin_by_profile());

DROP POLICY IF EXISTS "partner_profiles_admin_all" ON public.partner_profiles;
CREATE POLICY "partner_profiles_admin_all"
    ON public.partner_profiles FOR ALL
    USING (is_flux_admin_by_profile())
    WITH CHECK (is_flux_admin_by_profile());

DROP POLICY IF EXISTS "partner_api_keys_select_own_or_admin" ON public.partner_api_keys;
CREATE POLICY "partner_api_keys_select_own_or_admin"
    ON public.partner_api_keys FOR SELECT
    USING (
        partner_id IN (SELECT id FROM public.partner_profiles WHERE user_id = auth.uid())
        OR is_flux_admin_by_profile()
    );

DROP POLICY IF EXISTS "partner_api_keys_admin_all" ON public.partner_api_keys;
CREATE POLICY "partner_api_keys_admin_all"
    ON public.partner_api_keys FOR ALL
    USING (is_flux_admin_by_profile())
    WITH CHECK (is_flux_admin_by_profile());

DROP POLICY IF EXISTS "partner_ip_allowlist_select_own_or_admin" ON public.partner_ip_allowlist;
CREATE POLICY "partner_ip_allowlist_select_own_or_admin"
    ON public.partner_ip_allowlist FOR SELECT
    USING (
        partner_id IN (SELECT id FROM public.partner_profiles WHERE user_id = auth.uid())
        OR is_flux_admin_by_profile()
    );

DROP POLICY IF EXISTS "partner_ip_allowlist_admin_all" ON public.partner_ip_allowlist;
CREATE POLICY "partner_ip_allowlist_admin_all"
    ON public.partner_ip_allowlist FOR ALL
    USING (is_flux_admin_by_profile())
    WITH CHECK (is_flux_admin_by_profile());

DROP POLICY IF EXISTS "partner_service_costs_select_own_or_admin" ON public.partner_service_costs;
CREATE POLICY "partner_service_costs_select_own_or_admin"
    ON public.partner_service_costs FOR SELECT
    USING (
        partner_id IN (SELECT id FROM public.partner_profiles WHERE user_id = auth.uid())
        OR is_flux_admin_by_profile()
    );

DROP POLICY IF EXISTS "partner_service_costs_admin_all" ON public.partner_service_costs;
CREATE POLICY "partner_service_costs_admin_all"
    ON public.partner_service_costs FOR ALL
    USING (is_flux_admin_by_profile())
    WITH CHECK (is_flux_admin_by_profile());

-- Grants
GRANT EXECUTE ON FUNCTION public.rpc_admin_set_partner_status(UUID, BOOLEAN, NUMERIC, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_partner_get_my_profile() TO authenticated;
