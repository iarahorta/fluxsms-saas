-- ============================================================
-- FluxSMS - Migration 004: Service-Specific Stock Tracking
-- ============================================================

-- Função para obter estoque real por serviço chamável pelo Frontend
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
        SELECT count(*)
        FROM chips c
        WHERE c.status = 'idle'
        AND NOT EXISTS (
            SELECT 1 FROM activations a
            WHERE a.chip_id = c.id
            AND a.service = s.id
            AND a.status = 'received'
        )
    )) INTO v_result
    FROM (
        -- Pega todos os serviços conhecidos da config ou de ativações passadas
        SELECT id FROM services_config
        UNION
        SELECT DISTINCT service FROM activations
    ) s;
    
    RETURN COALESCE(v_result, '{}'::jsonb);
END;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_get_service_stocks() TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_get_service_stocks() TO anon; -- Permitir ver estoque antes de logar
