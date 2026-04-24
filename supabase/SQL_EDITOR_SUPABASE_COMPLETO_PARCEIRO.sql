-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ FluxSMS — SCRIPT PARA O SQL EDITOR DO SUPABASE (módulo parceiro + fin.) ║
-- ╠══════════════════════════════════════════════════════════════════════════╣
-- ║ Ordem: pré-requisitos → 004 partner → 005 services_config → 006 WA/polo ║
-- ║        → 007 saques → 008 cofre/HWID keys → 009 taxa saque R$ 5          ║
-- ╠══════════════════════════════════════════════════════════════════════════╣
-- ║ ANTES DE CORRER:                                                         ║
-- ║ • Já deve existir public.profiles, public.chips, public.activations,     ║
-- ║   public.transactions (schema base do projeto).                         ║
-- ║ • Se a sua base ainda NÃO tem polos/chips.polo_id/custom_prices,        ║
-- ║   execute PRIMEIRO no editor o ficheiro:                                 ║
-- ║   supabase/EXECUTE_NO_SUPABASE.sql (setup geral idempotente).            ║
-- ║ • Depois execute ESTE ficheiro inteiro (ou só 007–009 se o resto já      ║
-- ║   tiver sido aplicado via migrações CLI).                               ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

-- === PRÉ-REQUISITOS (006 rpc_solicitar_sms_v3 + fidelidade) =================
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

ALTER TABLE public.profiles
    ADD COLUMN IF NOT EXISTS total_recharged NUMERIC(10, 2) NOT NULL DEFAULT 0.00;

UPDATE public.profiles p
SET total_recharged = COALESCE((
    SELECT SUM(amount) FROM public.transactions t
    WHERE t.user_id = p.id AND t.type = 'credit'
), 0);

CREATE OR REPLACE FUNCTION public.update_total_recharged_after_credit()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.type = 'credit' THEN
        UPDATE public.profiles
        SET total_recharged = total_recharged + NEW.amount
        WHERE id = NEW.user_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_update_total_recharged ON public.transactions;
CREATE TRIGGER trg_update_total_recharged
    AFTER INSERT ON public.transactions
    FOR EACH ROW
    EXECUTE FUNCTION public.update_total_recharged_after_credit();

CREATE TABLE IF NOT EXISTS public.custom_prices (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id     UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    service     TEXT NOT NULL,
    price       NUMERIC(8, 2) NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, service)
);

CREATE TABLE IF NOT EXISTS public.polos (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    nome                TEXT NOT NULL,
    chave_acesso        TEXT NOT NULL UNIQUE,
    status              TEXT NOT NULL DEFAULT 'OFFLINE',
    chips_ativos        INTEGER DEFAULT 0,
    ultima_comunicacao  TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.chips
    ADD COLUMN IF NOT EXISTS polo_id UUID REFERENCES public.polos(id) ON DELETE SET NULL;

-- Índice útil para JOIN polo ↔ chip (não força UNIQUE(polo,porta) para não quebrar bases antigas)
CREATE INDEX IF NOT EXISTS idx_chips_polo_id ON public.chips(polo_id);

-- === INÍCIO DAS MIGRAÇÕES 004–009 (conteúdo do repositório) ==================

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
-- ============================================================
-- FluxSMS - Migration 005: Admin Fixes & Service Config
-- ============================================================

-- Tabela de Configuração Global de Preços
CREATE TABLE IF NOT EXISTS public.services_config (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    price NUMERIC(10,2) NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Popula com os serviços padrão if not exists
INSERT INTO public.services_config (id, name, price)
VALUES 
    ('whatsapp', 'WhatsApp', 6.10),
    ('telegram', 'Telegram', 4.00),
    ('google', 'Google / YT', 1.50),
    ('uber', 'Uber', 1.20),
    ('tinder', 'Tinder', 4.50),
    ('gov', 'GOV.BR', 5.00),
    ('ifood', 'iFood', 0.90),
    ('instagram', 'Instagram', 2.00),
    ('tiktok', 'TikTok', 1.50),
    ('apple', 'Apple ID', 3.00),
    ('shopee', 'Shopee', 0.80),
    ('mercadolivre', 'Mercado Livre', 1.20),
    ('nubank', 'Nubank', 2.50),
    ('twitter', 'X (Twitter)', 1.00),
    ('paypal', 'PayPal', 2.00)
ON CONFLICT (id) DO NOTHING;

-- RLS para services_config
ALTER TABLE public.services_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "services_config_select_all" ON public.services_config;
CREATE POLICY "services_config_select_all" ON public.services_config FOR SELECT USING (TRUE);
DROP POLICY IF EXISTS "services_config_admin_all" ON public.services_config;
CREATE POLICY "services_config_admin_all" ON public.services_config FOR ALL USING (
    (auth.jwt() ->> 'email' = 'iarachorta@gmail.com')
);

-- Realtime para services_config
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'services_config') THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.services_config;
    END IF;
END $$;
-- ============================================================
-- FluxSMS 006: Quarentena WhatsApp (30 dias) + vínculo Polo→Parceiro
-- Execute no Supabase SQL Editor (ou via CLI migrations).
-- ============================================================

-- 1) Chips: data em que o chip volta a poder vender WhatsApp
ALTER TABLE public.chips
    ADD COLUMN IF NOT EXISTS disponivel_em TIMESTAMPTZ;

COMMENT ON COLUMN public.chips.disponivel_em IS 'Após venda WhatsApp recebida: até quando o chip fica bloqueado para novo WhatsApp (30 dias).';

-- 2) Status: inclui quarentena (bloqueio só para WhatsApp; outros serviços seguem usando o chip)
ALTER TABLE public.chips DROP CONSTRAINT IF EXISTS chips_status_check;
ALTER TABLE public.chips
    ADD CONSTRAINT chips_status_check
    CHECK (status IN ('idle', 'busy', 'offline', 'quarentena'));

-- 3) Polo opcionalmente atribuído a um parceiro (para métricas no painel admin)
ALTER TABLE public.polos
    ADD COLUMN IF NOT EXISTS partner_profile_id UUID REFERENCES public.partner_profiles(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_polos_partner_profile_id ON public.polos(partner_profile_id);

-- Recria funções sem conflito de tipo/assinatura (evita ERROR 42P13)
DROP FUNCTION IF EXISTS public.rpc_get_service_stocks() CASCADE;
DROP FUNCTION IF EXISTS public.rpc_monitorar_e_estornar_v2() CASCADE;
DROP FUNCTION IF EXISTS public.rpc_cancelar_ativacao(UUID, UUID) CASCADE;
DROP FUNCTION IF EXISTS public.rpc_solicitar_sms_v3(UUID, TEXT, TEXT, NUMERIC) CASCADE;

-- 4) Impede "subir" chip com mesmo número enquanto outro registro ainda em quarentena WhatsApp
CREATE OR REPLACE FUNCTION public.trg_chips_valida_quarentena_numero()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
    v_conflict_until TIMESTAMPTZ;
    v_norm TEXT;
BEGIN
    IF NEW.numero IS NULL OR btrim(NEW.numero) = '' THEN
        RETURN NEW;
    END IF;

    v_norm := regexp_replace(lower(btrim(NEW.numero)), '\s+', '', 'g');

    SELECT MAX(c.disponivel_em) INTO v_conflict_until
    FROM public.chips c
    WHERE c.id IS DISTINCT FROM NEW.id
      AND c.numero IS NOT NULL
      AND btrim(c.numero) <> ''
      AND regexp_replace(lower(btrim(c.numero)), '\s+', '', 'g') = v_norm
      AND c.disponivel_em IS NOT NULL
      AND c.disponivel_em > NOW();

    IF v_conflict_until IS NOT NULL THEN
        RAISE EXCEPTION 'Em Quarentena (WhatsApp) até %', to_char(v_conflict_until AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI')
            USING ERRCODE = 'P0001';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_chips_valida_quarentena_numero ON public.chips;
CREATE TRIGGER trg_chips_valida_quarentena_numero
    BEFORE INSERT OR UPDATE OF numero ON public.chips
    FOR EACH ROW EXECUTE FUNCTION public.trg_chips_valida_quarentena_numero();

-- 5) Libera quarentena WhatsApp quando o prazo passa (chamado pelo Gari existente no frontend)
CREATE OR REPLACE FUNCTION public.rpc_monitorar_e_estornar_v2()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_rec RECORD;
    v_refund_amount NUMERIC(10, 2);
    v_count_polos INT := 0;
    v_count_refunds INT := 0;
    v_quar_released INT := 0;
BEGIN
    UPDATE public.polos
    SET status = 'OFFLINE'
    WHERE (ultima_comunicacao < NOW() - INTERVAL '90 seconds' OR ultima_comunicacao IS NULL)
      AND status <> 'OFFLINE';
    GET DIAGNOSTICS v_count_polos = ROW_COUNT;

    FOR v_rec IN
        SELECT a.id, a.user_id, a.price, a.service_name
        FROM public.activations a
        JOIN public.chips c ON a.chip_id = c.id
        JOIN public.polos p ON c.polo_id = p.id
        WHERE p.status = 'OFFLINE'
          AND a.status IN ('pending', 'waiting')
    LOOP
        SELECT t.amount INTO v_refund_amount
        FROM public.transactions t
        WHERE t.activation_id = v_rec.id
          AND t.user_id = v_rec.user_id
          AND t.type = 'debit'
        ORDER BY t.created_at DESC
        LIMIT 1;

        IF v_refund_amount IS NULL THEN
            v_refund_amount := v_rec.price;
        END IF;

        UPDATE public.profiles SET balance = balance + v_refund_amount WHERE id = v_rec.user_id;
        UPDATE public.activations SET status = 'expired', updated_at = NOW() WHERE id = v_rec.id;
        INSERT INTO public.transactions (user_id, activation_id, type, amount, description)
        VALUES (v_rec.user_id, v_rec.id, 'refund', v_refund_amount, 'Estorno: Polo Offline (' || v_rec.service_name || ')');
        v_count_refunds := v_count_refunds + 1;
    END LOOP;

    UPDATE public.chips
    SET status = 'idle',
        disponivel_em = NULL
    WHERE status = 'quarentena'
      AND disponivel_em IS NOT NULL
      AND disponivel_em <= NOW();
    GET DIAGNOSTICS v_quar_released = ROW_COUNT;

    RETURN jsonb_build_object(
        'ok', true,
        'polos_offline', v_count_polos,
        'estornos_realizados', v_count_refunds,
        'whatsapp_quarentena_liberados', v_quar_released
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_monitorar_e_estornar_v2() TO authenticated;

-- 6) Cancelamento: devolve chip ao estado correto (mantém quarentena WhatsApp se ainda vigente)
CREATE OR REPLACE FUNCTION public.rpc_cancelar_ativacao(
    p_user_id UUID,
    p_activation_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_activation RECORD;
    v_refund_amount NUMERIC(10, 2);
BEGIN
    SELECT * INTO v_activation
    FROM public.activations
    WHERE id = p_activation_id AND user_id = p_user_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'ativacao_nao_encontrada');
    END IF;

    IF v_activation.status = 'received' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'sms_ja_recebido_sem_reembolso');
    END IF;

    IF v_activation.status NOT IN ('pending', 'waiting') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'status_invalido_para_cancelamento');
    END IF;

    UPDATE public.activations SET status = 'cancelled' WHERE id = p_activation_id;

    UPDATE public.chips c
    SET
        status = CASE
            WHEN c.disponivel_em IS NOT NULL AND c.disponivel_em > NOW() THEN 'quarentena'
            ELSE 'idle'
        END
    WHERE c.id = v_activation.chip_id;

    SELECT t.amount INTO v_refund_amount
    FROM public.transactions t
    WHERE t.activation_id = p_activation_id
      AND t.user_id = p_user_id
      AND t.type = 'debit'
    ORDER BY t.created_at DESC
    LIMIT 1;

    IF v_refund_amount IS NULL THEN
        v_refund_amount := v_activation.price;
    END IF;

    UPDATE public.profiles SET balance = balance + v_refund_amount WHERE id = p_user_id;

    INSERT INTO public.transactions (user_id, activation_id, type, amount, description)
    VALUES (p_user_id, p_activation_id, 'refund', v_refund_amount, 'Reembolso: ' || v_activation.service_name);

    RETURN jsonb_build_object('ok', true, 'refunded', v_refund_amount);
END;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_cancelar_ativacao(UUID, UUID) TO authenticated;

-- 7) Estoque por serviço: WhatsApp respeita disponivel_em; demais serviços aceitam chip em quarentena
CREATE OR REPLACE FUNCTION public.rpc_get_service_stocks()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_result JSONB;
BEGIN
    SELECT jsonb_object_agg(s.id, (
        SELECT count(*)::INT
        FROM public.chips c
        WHERE (
            (s.id = 'whatsapp'
                AND c.status = 'idle'
                AND (c.disponivel_em IS NULL OR c.disponivel_em <= NOW()))
            OR (s.id <> 'whatsapp'
                AND c.status IN ('idle', 'quarentena')
                AND NOT EXISTS (
                    SELECT 1
                    FROM public.activations a
                    WHERE a.chip_id = c.id
                      AND a.service = s.id
                      AND a.status = 'received'
                ))
        )
    )) INTO v_result
    FROM (
        SELECT id FROM public.services_config
        UNION
        SELECT DISTINCT service FROM public.activations
    ) s;

    RETURN COALESCE(v_result, '{}'::JSONB);
END;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_get_service_stocks() TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_get_service_stocks() TO anon;

-- 8) Solicitar SMS V3: seleção de chip alinhada à quarentena WhatsApp
CREATE OR REPLACE FUNCTION public.rpc_solicitar_sms_v3(
    p_user_id UUID,
    p_service TEXT,
    p_service_name TEXT,
    p_default_price NUMERIC
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_balance NUMERIC;
    v_total_recharged NUMERIC;
    v_fidelity_level TEXT;
    v_chip RECORD;
    v_activation_id UUID;
    v_base_price NUMERIC;
    v_final_price NUMERIC;
    v_discount NUMERIC := 0;
    v_lab_polo_id UUID := 'ba768131-e67e-4299-bf5a-96503f92076c';
BEGIN
    SELECT COALESCE(
        (SELECT price FROM public.custom_prices WHERE user_id = p_user_id AND service = p_service),
        p_default_price
    ) INTO v_base_price;

    PERFORM public.rpc_refresh_fidelity_level(p_user_id);

    SELECT balance, COALESCE(total_recharged, 0), COALESCE(fidelity_level, 'BRONZE')
    INTO v_balance, v_total_recharged, v_fidelity_level
    FROM public.profiles
    WHERE id = p_user_id
    FOR UPDATE;

    IF v_fidelity_level = 'DIAMANTE' THEN
        v_discount := 0.20;
    END IF;

    v_final_price := ROUND(v_base_price * (1.0 - v_discount), 2);

    IF v_balance < v_final_price THEN
        RETURN jsonb_build_object('ok', false, 'error', 'saldo_insuficiente', 'saldo', v_balance, 'preco_final', v_final_price);
    END IF;

    SELECT c.* INTO v_chip
    FROM public.chips c
    JOIN public.polos p ON c.polo_id = p.id
    WHERE p.status = 'ONLINE'
      AND (
          p.ultima_comunicacao > NOW() - INTERVAL '90 seconds'
          OR p.id = v_lab_polo_id
      )
      AND (
          (p_service = 'whatsapp'
              AND c.status = 'idle'
              AND (c.disponivel_em IS NULL OR c.disponivel_em <= NOW()))
          OR (p_service <> 'whatsapp'
              AND c.status IN ('idle', 'quarentena')
              AND NOT EXISTS (
                  SELECT 1
                  FROM public.activations act
                  WHERE act.chip_id = c.id
                    AND act.service = p_service
                    AND act.status = 'received'
              ))
      )
    ORDER BY (
        SELECT count(*)
        FROM public.activations a2
        JOIN public.chips c2 ON a2.chip_id = c2.id
        WHERE c2.polo_id = p.id
          AND a2.status IN ('pending', 'waiting')
    ) ASC, random()
    LIMIT 1
    FOR UPDATE SKIP LOCKED;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'sem_chips');
    END IF;

    UPDATE public.chips SET status = 'busy' WHERE id = v_chip.id;
    UPDATE public.profiles SET balance = balance - v_final_price WHERE id = p_user_id;

    INSERT INTO public.activations (user_id, chip_id, service, service_name, price, phone_number, status)
    VALUES (p_user_id, v_chip.id, p_service, p_service_name, v_final_price, COALESCE(v_chip.numero, 'AGUARDANDO'), 'waiting')
    RETURNING id INTO v_activation_id;

    INSERT INTO public.transactions (user_id, activation_id, type, amount, description)
    VALUES (p_user_id, v_activation_id, 'debit', v_final_price, 'SMS: ' || p_service_name);

    RETURN jsonb_build_object(
        'ok', true,
        'activation_id', v_activation_id,
        'numero', v_chip.numero,
        'preco_aplicado', v_final_price,
        'desconto_aplicado', v_discount
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_solicitar_sms_v3(UUID, TEXT, TEXT, NUMERIC) TO authenticated;
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
-- ============================================================
-- FluxSMS - Migration 008: HWID + cofre da chave (painel parceiro)
-- ============================================================

ALTER TABLE public.partner_api_keys
    ADD COLUMN IF NOT EXISTS bound_hwid TEXT,
    ADD COLUMN IF NOT EXISTS secret_ciphertext TEXT,
    ADD COLUMN IF NOT EXISTS secret_iv TEXT,
    ADD COLUMN IF NOT EXISTS secret_tag TEXT;

-- Uma chave ativa por parceiro: garantido na aplicação (onboarding + rotação admin).
-- Taxa fixa de processamento por pedido de saque (parceiro)
ALTER TABLE public.partner_withdrawal_requests
    ADD COLUMN IF NOT EXISTS fee_brl NUMERIC(10, 2) NOT NULL DEFAULT 5.00,
    ADD COLUMN IF NOT EXISTS net_amount NUMERIC(12, 2),
    ADD COLUMN IF NOT EXISTS fee_applied_at TIMESTAMPTZ;

UPDATE public.partner_withdrawal_requests
SET net_amount = ROUND((amount - COALESCE(fee_brl, 5))::numeric, 2)
WHERE net_amount IS NULL;

-- === Verificação opcional (pode apagar se der erro de permissão no Editor) ===
SELECT 'partner_profiles' AS tabela,
       EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'partner_profiles') AS ok;
SELECT 'partner_withdrawal_requests' AS tabela,
       EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'partner_withdrawal_requests') AS ok;
SELECT 'rpc_solicitar_sms_v3' AS rotina,
       EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'rpc_solicitar_sms_v3') AS ok;
