-- ============================================================
-- FluxSMS - Migration 008: HWID + cofre da chave (painel parceiro)
-- ============================================================

ALTER TABLE public.partner_api_keys
    ADD COLUMN IF NOT EXISTS bound_hwid TEXT,
    ADD COLUMN IF NOT EXISTS secret_ciphertext TEXT,
    ADD COLUMN IF NOT EXISTS secret_iv TEXT,
    ADD COLUMN IF NOT EXISTS secret_tag TEXT;

-- Uma chave ativa por parceiro: garantido na aplicação (onboarding + rotação admin).
