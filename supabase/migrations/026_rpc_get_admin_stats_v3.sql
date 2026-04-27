-- 026: versiona rpc_get_admin_stats_v3 no repositório para evitar drift de schema.
-- Regra oficial do KPI chips_online (Admin): online agora (estrito).

CREATE OR REPLACE FUNCTION public.rpc_get_admin_stats_v3()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_users_count INT := 0;
    v_balance_total NUMERIC := 0;
    v_chips_online INT := 0;
    v_sms_count INT := 0;
BEGIN
    SELECT COUNT(*)::INT
      INTO v_users_count
      FROM public.profiles;

    SELECT COALESCE(SUM(balance), 0)
      INTO v_balance_total
      FROM public.profiles;

    SELECT COUNT(*)::INT
      INTO v_chips_online
      FROM public.chips c
     WHERE lower(trim(COALESCE(c.status, ''))) IN ('online', 'on', 'active');

    SELECT COUNT(*)::INT
      INTO v_sms_count
      FROM public.activations a
     WHERE a.created_at >= date_trunc('day', now());

    RETURN jsonb_build_object(
        'users_count', v_users_count,
        'balance_total', v_balance_total,
        'chips_online', v_chips_online,
        'sms_count', v_sms_count
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_get_admin_stats_v3() TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_get_admin_stats_v3() TO anon;

NOTIFY pgrst, 'reload schema';
