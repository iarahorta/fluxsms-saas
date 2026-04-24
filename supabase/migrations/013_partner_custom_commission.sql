-- ============================================================
-- FluxSMS 013: Comissão customizada por parceiro
-- ============================================================

ALTER TABLE public.partner_profiles
    ADD COLUMN IF NOT EXISTS custom_commission INTEGER;

COMMENT ON COLUMN public.partner_profiles.custom_commission IS
'Percentual de comissão do parceiro (inteiro). Se NULL, backend usa padrão 60.';
