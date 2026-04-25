-- ============================================================
-- FluxSMS - Migration 010: Leads de contato e preferência
-- ============================================================

ALTER TABLE public.profiles
    ADD COLUMN IF NOT EXISTS whatsapp TEXT,
    ADD COLUMN IF NOT EXISTS preferred_operator TEXT NOT NULL DEFAULT 'any';

ALTER TABLE public.profiles
    DROP CONSTRAINT IF EXISTS profiles_preferred_operator_check;

ALTER TABLE public.profiles
    ADD CONSTRAINT profiles_preferred_operator_check
    CHECK (preferred_operator IN ('any', 'vivo', 'claro', 'tim', 'oi'));
