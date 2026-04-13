-- ============================================================
-- FluxSMS - Script Único de Setup Completo
-- COLE ESTE ARQUIVO NO SQL EDITOR DO SUPABASE E EXECUTE
-- Supabase Dashboard > SQL Editor > New Query > Cole e Run
-- ============================================================

-- Configuração de timezone para São Paulo
SET timezone = 'America/Sao_Paulo';

-- ============================================================
-- PARTE 1: EXTENSÕES
-- ============================================================
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- PARTE 2: TABELAS
-- ============================================================

-- ─── PROFILES (vinculado ao auth.users) ──────────────────────
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
COMMENT ON TABLE public.profiles IS 'Perfis dos usuários do FluxSMS com saldo em Real (BRL)';

-- ─── CHIPS (Modems físicos) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS public.chips (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    porta       TEXT NOT NULL UNIQUE,
    numero      TEXT,
    operadora   TEXT,
    status      TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle','busy','offline')),
    last_seen   TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE public.chips IS 'Modems GSM físicos disponíveis para venda de SMS';

-- ─── ACTIVATIONS (Solicitações de SMS — histórico de mensagens) ──
CREATE TABLE IF NOT EXISTS public.activations (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    chip_id         UUID REFERENCES public.chips(id),
    service         TEXT NOT NULL,
    service_name    TEXT NOT NULL,
    price           NUMERIC(8, 2) NOT NULL,
    phone_number    TEXT,
    sms_code        TEXT,
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','waiting','received','cancelled','expired')),
    expires_at      TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '20 minutes'),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE public.activations IS 'Histórico de mensagens SMS solicitadas e recebidas';

-- ─── TRANSACTIONS (Histórico financeiro de saldo) ─────────────
CREATE TABLE IF NOT EXISTS public.transactions (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    activation_id   UUID REFERENCES public.activations(id),
    type            TEXT NOT NULL CHECK (type IN ('credit','debit','refund')),
    amount          NUMERIC(10, 2) NOT NULL,
    description     TEXT,
    mp_payment_id   TEXT,
    mp_status       TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE public.transactions IS 'Histórico financeiro: recargas Pix, compras de SMS e reembolsos';

-- ============================================================
-- PARTE 3: TRIGGERS
-- ============================================================

-- Updated_at automático
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_profiles_updated_at
    BEFORE UPDATE ON public.profiles
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE OR REPLACE TRIGGER trg_activations_updated_at
    BEFORE UPDATE ON public.activations
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Criar profile automaticamente no cadastro
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO public.profiles (id, email, full_name)
    VALUES (
        NEW.id,
        NEW.email,
        COALESCE(NEW.raw_user_meta_data->>'full_name', split_part(NEW.email,'@',1))
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ============================================================
-- PARTE 4: ROW LEVEL SECURITY (RLS)
-- ============================================================
ALTER TABLE public.profiles     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chips        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activations  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;

-- Profiles: cada usuário vê apenas seus dados
CREATE POLICY "profiles_select_own" ON public.profiles
    FOR SELECT USING (auth.uid() = id);
CREATE POLICY "profiles_update_own" ON public.profiles
    FOR UPDATE USING (auth.uid() = id) WITH CHECK (auth.uid() = id);

-- Chips: todos autenticados veem (para mostrar disponibilidade)
CREATE POLICY "chips_select_authenticated" ON public.chips
    FOR SELECT TO authenticated USING (TRUE);
CREATE POLICY "chips_all_service_role" ON public.chips
    FOR ALL TO service_role USING (TRUE);

-- Activations: usuário vê apenas as suas
CREATE POLICY "activations_select_own" ON public.activations
    FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "activations_insert_service" ON public.activations
    FOR INSERT TO service_role WITH CHECK (TRUE);
CREATE POLICY "activations_update_service" ON public.activations
    FOR UPDATE TO service_role USING (TRUE);

-- Transactions: usuário vê apenas as suas
CREATE POLICY "transactions_select_own" ON public.transactions
    FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "transactions_insert_service" ON public.transactions
    FOR INSERT TO service_role WITH CHECK (TRUE);

-- ============================================================
-- PARTE 5: FUNÇÕES RPC (Controle de Saldo Seguro)
-- ============================================================

-- CREDITAR SALDO (Webhook MP → service_role only)
CREATE OR REPLACE FUNCTION public.rpc_creditar_saldo(
    p_user_id UUID, p_amount NUMERIC, p_mp_payment_id TEXT, p_mp_status TEXT
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_exists BOOLEAN;
BEGIN
    SELECT EXISTS(SELECT 1 FROM transactions WHERE mp_payment_id = p_mp_payment_id) INTO v_exists;
    IF v_exists THEN RETURN jsonb_build_object('ok',false,'error','ja_processado'); END IF;
    IF p_mp_status != 'approved' THEN RETURN jsonb_build_object('ok',false,'error','nao_aprovado','status',p_mp_status); END IF;
    UPDATE profiles SET balance = balance + p_amount WHERE id = p_user_id;
    INSERT INTO transactions (user_id,type,amount,description,mp_payment_id,mp_status)
    VALUES (p_user_id,'credit',p_amount,'Recarga Pix',p_mp_payment_id,p_mp_status);
    RETURN jsonb_build_object('ok',true,'creditado',p_amount);
END; $$;

-- SOLICITAR SMS (Anti race-condition com FOR UPDATE)
CREATE OR REPLACE FUNCTION public.rpc_solicitar_sms(
    p_user_id UUID, p_service TEXT, p_service_name TEXT, p_price NUMERIC
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_balance NUMERIC; v_chip RECORD; v_activation_id UUID;
BEGIN
    SELECT balance INTO v_balance FROM profiles WHERE id = p_user_id FOR UPDATE;
    IF v_balance < p_price THEN RETURN jsonb_build_object('ok',false,'error','saldo_insuficiente','saldo',v_balance); END IF;
    SELECT * INTO v_chip FROM chips WHERE status='idle' LIMIT 1 FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'error','sem_chips'); END IF;
    UPDATE chips SET status='busy' WHERE id = v_chip.id;
    UPDATE profiles SET balance = balance - p_price WHERE id = p_user_id;
    INSERT INTO activations (user_id,chip_id,service,service_name,price,phone_number,status)
    VALUES (p_user_id,v_chip.id,p_service,p_service_name,p_price,COALESCE(v_chip.numero,'+55 XX XXXX-XXXX'),'waiting')
    RETURNING id INTO v_activation_id;
    INSERT INTO transactions (user_id,activation_id,type,amount,description)
    VALUES (p_user_id,v_activation_id,'debit',p_price,'SMS: '||p_service_name);
    RETURN jsonb_build_object('ok',true,'activation_id',v_activation_id,'numero',v_chip.numero);
END; $$;

-- CANCELAR (Trava: SMS recebido = sem reembolso)
CREATE OR REPLACE FUNCTION public.rpc_cancelar_ativacao(
    p_user_id UUID, p_activation_id UUID
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_act RECORD;
BEGIN
    SELECT * INTO v_act FROM activations WHERE id=p_activation_id AND user_id=p_user_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'error','nao_encontrado'); END IF;
    IF v_act.status = 'received' THEN RETURN jsonb_build_object('ok',false,'error','sms_recebido_sem_reembolso'); END IF;
    IF v_act.status NOT IN ('pending','waiting') THEN RETURN jsonb_build_object('ok',false,'error','status_invalido'); END IF;
    UPDATE activations SET status='cancelled' WHERE id=p_activation_id;
    UPDATE chips SET status='idle' WHERE id=v_act.chip_id;
    UPDATE profiles SET balance = balance + v_act.price WHERE id=p_user_id;
    INSERT INTO transactions (user_id,activation_id,type,amount,description)
    VALUES (p_user_id,p_activation_id,'refund',v_act.price,'Reembolso: '||v_act.service_name);
    RETURN jsonb_build_object('ok',true,'reembolsado',v_act.price);
END; $$;

-- ============================================================
-- PARTE 6: PERMISSÕES
-- ============================================================
GRANT EXECUTE ON FUNCTION public.rpc_solicitar_sms      TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_cancelar_ativacao  TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_creditar_saldo     TO service_role;

-- ============================================================
-- PARTE 7: REALTIME (SMS em tempo real)
-- ============================================================
ALTER PUBLICATION supabase_realtime ADD TABLE public.activations;
ALTER PUBLICATION supabase_realtime ADD TABLE public.profiles;

-- ============================================================
-- VERIFICAÇÃO FINAL
-- ============================================================
SELECT 
    schemaname,
    tablename,
    tableowner
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN ('profiles','chips','activations','transactions')
ORDER BY tablename;
