-- ============================================================
-- FluxSMS - Script de Setup Completo (Admin + Robustez)
-- VERSÃO IDEMPOTENTE: PODE SER EXECUTADO MÚLTIPLAS VEZES
-- ============================================================

SET timezone = 'America/Sao_Paulo';

-- ============================================================
-- PARTE 1: EXTENSÕES
-- ============================================================
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- PARTE 2: TABELAS
-- ============================================================

-- ─── PROFILES ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.profiles (
    id          UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email       TEXT NOT NULL,
    full_name   TEXT,
    balance     NUMERIC(10, 2) NOT NULL DEFAULT 0.00 CHECK (balance >= 0),
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    is_admin    BOOLEAN NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── CUSTOM PRICES (Novo: Preços por usuário) ───────────────
CREATE TABLE IF NOT EXISTS public.custom_prices (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id     UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    service     TEXT NOT NULL, -- ex: 'whatsapp', 'telegram'
    price       NUMERIC(8, 2) NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, service)
);
COMMENT ON TABLE public.custom_prices IS 'Preços customizados para usuários específicos (revendedores)';

-- ─── CHIPS (Modems GSM) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.chips (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    porta       TEXT NOT NULL UNIQUE,
    numero      TEXT,
    operadora   TEXT,
    status      TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle','busy','offline')),
    last_seen   TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── ACTIVATIONS (SMS) ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.activations (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    chip_id         UUID REFERENCES public.chips(id),
    service         TEXT NOT NULL,
    service_name    TEXT NOT NULL,
    price           NUMERIC(8, 2) NOT NULL,
    phone_number    TEXT,
    sms_code        TEXT,
    status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','waiting','received','cancelled','expired')),
    expires_at      TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '20 minutes'),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── TRANSACTIONS ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.transactions (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    activation_id   UUID REFERENCES public.activations(id),
    type            TEXT NOT NULL CHECK (type IN ('credit','debit','refund', 'admin_adj')),
    amount          NUMERIC(10, 2) NOT NULL,
    description     TEXT,
    mp_payment_id   TEXT,
    mp_status       TEXT,
    admin_id        UUID REFERENCES auth.users(id), -- Quem fez o ajuste se for admin_adj
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- PARTE 3: TRIGGERS & FUNCTIONS (Automáticos)
-- ============================================================

CREATE OR REPLACE FUNCTION public.set_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;

-- Dropar triggers se existirem antes de recriar
DROP TRIGGER IF EXISTS trg_profiles_updated_at ON public.profiles;
CREATE TRIGGER trg_profiles_updated_at BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_activations_updated_at ON public.activations;
CREATE TRIGGER trg_activations_updated_at BEFORE UPDATE ON public.activations FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Criar profile automaticamente no Auth.SignUp
CREATE OR REPLACE FUNCTION public.handle_new_user() RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO public.profiles (id, email, full_name, is_admin)
    VALUES (
        NEW.id,
        NEW.email,
        COALESCE(NEW.raw_user_meta_data->>'full_name', split_part(NEW.email,'@',1)),
        (NEW.email = 'iarachorta@gmail.com') -- Define admin automaticamente para o seu email
    );
    RETURN NEW;
END; $$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ============================================================
-- PARTE 4: ROW LEVEL SECURITY (RLS) - REVISADO
-- ============================================================
ALTER TABLE public.profiles     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chips        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activations  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.custom_prices ENABLE ROW LEVEL SECURITY;

-- Ajuda: função para checar se é Admin do FluxSMS
CREATE OR REPLACE FUNCTION public.is_flux_admin() RETURNS BOOLEAN AS $$
BEGIN
    RETURN (auth.jwt() ->> 'email' = 'iarachorta@gmail.com');
END; $$ LANGUAGE plpgsql SECURITY DEFINER;

-- PROFILES
DROP POLICY IF EXISTS "profiles_select_own" ON public.profiles;
CREATE POLICY "profiles_select_own" ON public.profiles FOR SELECT USING (auth.uid() = id OR is_flux_admin());

DROP POLICY IF EXISTS "profiles_update_own" ON public.profiles;
CREATE POLICY "profiles_update_own" ON public.profiles FOR UPDATE USING (auth.uid() = id OR is_flux_admin());

-- CHIPS
DROP POLICY IF EXISTS "chips_select_authenticated" ON public.chips;
CREATE POLICY "chips_select_authenticated" ON public.chips FOR SELECT TO authenticated USING (TRUE);

DROP POLICY IF EXISTS "chips_all_admin" ON public.chips;
CREATE POLICY "chips_all_admin" ON public.chips FOR ALL USING (is_flux_admin());

-- CUSTOM PRICES
DROP POLICY IF EXISTS "custom_prices_select_own" ON public.custom_prices;
CREATE POLICY "custom_prices_select_own" ON public.custom_prices FOR SELECT USING (auth.uid() = user_id OR is_flux_admin());

DROP POLICY IF EXISTS "custom_prices_admin" ON public.custom_prices;
CREATE POLICY "custom_prices_admin" ON public.custom_prices FOR ALL USING (is_flux_admin());

-- ============================================================
-- PARTE 5: FUNÇÕES RPC ADMIN (Ações Seguras)
-- ============================================================

-- ADMIN: Ajustar Saldo Manual
CREATE OR REPLACE FUNCTION public.rpc_admin_adjust_balance(
    p_user_id UUID, p_amount NUMERIC, p_description TEXT
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
    IF NOT is_flux_admin() THEN RETURN jsonb_build_object('ok',false,'error','Unauthorized'); END IF;
    
    UPDATE profiles SET balance = balance + p_amount WHERE id = p_user_id;
    INSERT INTO transactions (user_id, type, amount, description, admin_id)
    VALUES (p_user_id, 'admin_adj', p_amount, p_description, auth.uid());
    
    RETURN jsonb_build_object('ok',true);
END; $$;

-- ADMIN: Banir/Desbanir Usuário
CREATE OR REPLACE FUNCTION public.rpc_admin_set_user_status(
    p_user_id UUID, p_active BOOLEAN
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
    IF NOT is_flux_admin() THEN RETURN jsonb_build_object('ok',false,'error','Unauthorized'); END IF;
    UPDATE profiles SET is_active = p_active WHERE id = p_user_id;
    RETURN jsonb_build_object('ok',true);
END; $$;

-- USUÁRIO: Solicitar SMS com Preço Dinâmico (Leva em conta custom_price)
CREATE OR REPLACE FUNCTION public.rpc_solicitar_sms_v2(
    p_user_id UUID, p_service TEXT, p_service_name TEXT, p_default_price NUMERIC
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_balance NUMERIC; v_chip RECORD; v_activation_id UUID; v_final_price NUMERIC;
BEGIN
    -- 1. Determina o preço final (Custom se existir, senão o Default enviado)
    SELECT COALESCE((SELECT price FROM custom_prices WHERE user_id = p_user_id AND service = p_service), p_default_price) 
    INTO v_final_price;

    -- 2. Verifica saldo
    SELECT balance INTO v_balance FROM profiles WHERE id = p_user_id FOR UPDATE;
    IF v_balance < v_final_price THEN RETURN jsonb_build_object('ok',false,'error','saldo_insuficiente','saldo',v_balance); END IF;
    
    -- 3. Busca chip disponível
    SELECT * INTO v_chip FROM chips WHERE status='idle' LIMIT 1 FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'error','sem_chips'); END IF;
    
    -- 4. Processa
    UPDATE chips SET status='busy' WHERE id = v_chip.id;
    UPDATE profiles SET balance = balance - v_final_price WHERE id = p_user_id;
    
    INSERT INTO activations (user_id,chip_id,service,service_name,price,phone_number,status)
    VALUES (p_user_id, v_chip.id, p_service, p_service_name, v_final_price, COALESCE(v_chip.numero,'AGUARDANDO'), 'waiting')
    RETURNING id INTO v_activation_id;
    
    INSERT INTO transactions (user_id, activation_id, type, amount, description)
    VALUES (p_user_id, v_activation_id, 'debit', v_final_price, 'SMS: '||p_service_name);
    
    RETURN jsonb_build_object('ok',true, 'activation_id', v_activation_id, 'numero', v_chip.numero, 'preco_aplicado', v_final_price);
END; $$;

-- ============================================================
-- PARTE 6: PERMISSÕES & REALTIME
-- ============================================================
GRANT EXECUTE ON FUNCTION public.rpc_solicitar_sms_v2    TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_admin_adjust_balance TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_admin_set_user_status TO authenticated;

-- Garantir que custom_prices e transactions também estão no Realtime para o Admin
ALTER PUBLICATION supabase_realtime ADD TABLE public.custom_prices;
ALTER PUBLICATION supabase_realtime ADD TABLE public.transactions;
ALTER PUBLICATION supabase_realtime ADD TABLE public.chips;

-- ============================================================
-- VERIFICAÇÃO FINAL
-- ============================================================
SELECT 
    schemaname, tablename, 
    (SELECT count(*) FROM pg_policies WHERE tablename = pt.tablename) as policies_count
FROM pg_tables pt
WHERE schemaname = 'public' AND tablename IN ('profiles','chips','activations','transactions','custom_prices')
ORDER BY tablename;
