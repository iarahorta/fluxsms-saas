-- ============================================================
-- FluxSMS - Migration 001: Core Tables
-- ============================================================

-- Extensões necessárias
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─── PROFILES ────────────────────────────────────────────────
-- Vinculado ao auth.users do Supabase via trigger
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

-- ─── CHIPS (Modems físicos) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS public.chips (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    porta       TEXT NOT NULL UNIQUE,         -- Ex: COM121
    numero      TEXT,                         -- Número do chip detectado
    operadora   TEXT,                         -- Vivo, Claro, TIM...
    status      TEXT NOT NULL DEFAULT 'idle'  -- idle | busy | offline
                CHECK (status IN ('idle','busy','offline')),
    last_seen   TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── ACTIVATIONS (Solicitações de SMS) ───────────────────────
CREATE TABLE IF NOT EXISTS public.activations (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    chip_id         UUID REFERENCES public.chips(id),
    service         TEXT NOT NULL,            -- whatsapp | telegram | uber ...
    service_name    TEXT NOT NULL,
    price           NUMERIC(8, 2) NOT NULL,
    phone_number    TEXT,                     -- Número fornecido ao cliente
    sms_code        TEXT,                     -- Código recebido (REALTIME)
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','waiting','received','cancelled','expired')),
    expires_at      TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '20 minutes'),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── TRANSACTIONS (Histórico Financeiro) ─────────────────────
CREATE TABLE IF NOT EXISTS public.transactions (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    activation_id   UUID REFERENCES public.activations(id),
    type            TEXT NOT NULL CHECK (type IN ('credit','debit','refund')),
    amount          NUMERIC(10, 2) NOT NULL,
    description     TEXT,
    mp_payment_id   TEXT,                    -- ID do Mercado Pago (para créditos)
    mp_status       TEXT,                    -- approved | pending | rejected
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── TRIGGERS: updated_at automático ─────────────────────────
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_profiles_updated_at
    BEFORE UPDATE ON public.profiles
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_activations_updated_at
    BEFORE UPDATE ON public.activations
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ─── TRIGGER: Criar profile automaticamente após cadastro ────
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO public.profiles (id, email, full_name)
    VALUES (
        NEW.id,
        NEW.email,
        COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email)
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
