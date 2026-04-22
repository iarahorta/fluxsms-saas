-- ============================================================
-- FluxSMS - Migration 004: Service-Specific Stock Tracking
-- ============================================================

-- Função para obter estoque real por serviço chamável pelo Frontend
-- Estoque por serviço (WhatsApp respeita disponivel_em; ver migration 006 para DDL completo)
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
                    SELECT 1 FROM public.activations a
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
GRANT EXECUTE ON FUNCTION public.rpc_get_service_stocks() TO anon; -- Permitir ver estoque antes de logar
