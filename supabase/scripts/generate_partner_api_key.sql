-- ============================================================
-- Gerar primeira (ou nova) Partner API Key — executar no SQL Editor
-- A chave em texto aparece UMA VEZ em "Messages" / NOTICE do Supabase.
-- Pré-requisito: ter um registo em public.partner_profiles (migration 004 + RPC admin ou insert manual).
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 1) Descobre o UUID do parceiro (ajuste o e-mail ou use o id direto)
-- SELECT id, partner_code, user_id FROM public.partner_profiles;

DO $$
DECLARE
    v_partner_id UUID := NULL;  -- preencher: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'
    v_plain      TEXT;
    v_hash       TEXT;
    v_prefix     TEXT;
BEGIN
    IF v_partner_id IS NULL THEN
        RAISE EXCEPTION 'Edite o script: defina v_partner_id com o UUID de public.partner_profiles.id';
    END IF;

    v_plain := 'flux_partner_' || replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
    v_hash  := encode(digest(v_plain, 'sha256'), 'hex');
    v_prefix := left(v_plain, 12);

    INSERT INTO public.partner_api_keys (partner_id, key_hash, key_prefix, label, is_active)
    VALUES (v_partner_id, v_hash, v_prefix, 'Gerada via SQL (lab)', true);

    RAISE NOTICE '========================================';
    RAISE NOTICE 'COPIE AGORA A PARTNER API KEY (não fica na base):';
    RAISE NOTICE '%', v_plain;
    RAISE NOTICE '========================================';
END $$;

-- Opcional: permitir o teu IP atual (substitua X.X.X.X). Lista vazia = todos os IPs permitidos.
-- INSERT INTO public.partner_ip_allowlist (partner_id, ip_or_cidr, label, is_active)
-- VALUES ('PARTNER_PROFILE_UUID', '203.0.113.50', 'Escritório', true);
