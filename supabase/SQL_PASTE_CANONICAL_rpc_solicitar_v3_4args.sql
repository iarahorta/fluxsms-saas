-- =============================================================================
-- CANÓNICO: alinhado ao site (app.js) e a callRpcSolicitarSmsV3ApenasQuatro
-- Assinatura: public.rpc_solicitar_sms_v3(UUID, TEXT, TEXT, NUMERIC) — 4 parâmetros.
-- Depois: NOTIFY pgrst, 'reload schema';
-- Não adicione o 5.º par no front sem recriar a função e fazer reload do PostgREST.
-- =============================================================================

-- Preferir CREATE OR REPLACE (evita CASCADE acidental). Se ainda existir overload (…, UUID), apague manualmente a variante antiga.
CREATE OR REPLACE FUNCTION public.rpc_solicitar_sms_v3(
    p_user_id UUID,
    p_service TEXT,
    p_service_name TEXT,
    p_default_price NUMERIC
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_auth_user_id UUID := auth.uid();
    v_effective_user_id UUID;
    v_balance NUMERIC;
    v_total_recharged NUMERIC;
    v_fidelity_level TEXT;
    v_chip RECORD;
    v_activation_id UUID;
    v_base_price NUMERIC;
    v_final_price NUMERIC;
    v_discount NUMERIC := 0;
    v_service_key TEXT := lower(trim(p_service));
    v_phone_display TEXT;
BEGIN
    IF v_auth_user_id IS NULL AND p_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'nao_autenticado');
    END IF;

    IF v_auth_user_id IS NOT NULL AND p_user_id IS NOT NULL AND v_auth_user_id <> p_user_id THEN
        RETURN jsonb_build_object('ok', false, 'error', 'user_mismatch');
    END IF;

    v_effective_user_id := COALESCE(v_auth_user_id, p_user_id);

    SELECT COALESCE(
        (SELECT price FROM public.custom_prices WHERE user_id = v_effective_user_id AND service = p_service),
        p_default_price
    ) INTO v_base_price;

    PERFORM public.rpc_refresh_fidelity_level(v_effective_user_id);

    SELECT balance, COALESCE(total_recharged, 0), COALESCE(fidelity_level, 'BRONZE')
    INTO v_balance, v_total_recharged, v_fidelity_level
    FROM public.profiles
    WHERE id = v_effective_user_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'usuario_invalido');
    END IF;

    IF v_fidelity_level = 'DIAMANTE' THEN
        v_discount := 0.20;
    END IF;

    v_final_price := ROUND(v_base_price * (1.0 - v_discount), 2);

    IF v_balance < v_final_price THEN
        RETURN jsonb_build_object('ok', false, 'error', 'saldo_insuficiente', 'saldo', v_balance, 'preco_final', v_final_price);
    END IF;

    SELECT c.* INTO v_chip
    FROM public.chips c
    JOIN public.polos p ON c.polo_id = p.id
    WHERE COALESCE(c.chip_service_off ->> v_service_key, 'false') <> 'true'
      AND (c.numero::text IS NULL OR c.numero::text NOT ILIKE 'CCID%')
      /* Alinha com o que o admin chama de “ON”: idle, on, online, active, e offline com sinal; não só 'idle'. */
      AND (
          (v_service_key = 'whatsapp'
              AND (
                  lower(trim(c.status::text)) IN ('idle', 'on', 'online', 'active')
                  OR (
                      lower(trim(c.status::text)) = 'offline'
                      AND (
                          c.last_ping > NOW() - INTERVAL '60 minutes'
                          OR p.ultima_comunicacao > NOW() - INTERVAL '60 minutes'
                      )
                  )
              )
              AND (c.disponivel_em IS NULL OR c.disponivel_em <= NOW()))
          OR (v_service_key <> 'whatsapp'
              AND (
                  lower(trim(c.status::text)) IN ('idle', 'quarentena', 'on', 'online', 'active')
                  OR (
                      lower(trim(c.status::text)) = 'offline'
                      AND (
                          c.last_ping > NOW() - INTERVAL '60 minutes'
                          OR p.ultima_comunicacao > NOW() - INTERVAL '60 minutes'
                      )
                  )
              )
              AND NOT EXISTS (
                  SELECT 1
                  FROM public.activations act
                  WHERE act.chip_id = c.id
                    AND act.service = p_service
                    AND act.status = 'received'
              ))
      )
    ORDER BY
        CASE WHEN lower(trim(c.status::text)) = 'idle' THEN 0 ELSE 1 END ASC,
        CASE
            WHEN lower(trim(c.status::text)) = 'idle' THEN COALESCE(c.disponivel_em, c.created_at)
            ELSE NULL
        END ASC NULLS LAST,
        COALESCE(c.last_ping, p.ultima_comunicacao, to_timestamp(0)) DESC,
        (
            SELECT count(*)
            FROM public.activations a2
            JOIN public.chips c2 ON a2.chip_id = c2.id
            WHERE c2.polo_id = p.id
              AND a2.status IN ('pending', 'waiting')
        ) ASC,
        random()
    LIMIT 1
    FOR UPDATE SKIP LOCKED;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'sem_chips');
    END IF;

    v_phone_display := COALESCE(NULLIF(trim(v_chip.numero::text), ''), 'AGUARDANDO');

    UPDATE public.chips SET status = 'busy' WHERE id = v_chip.id;
    UPDATE public.profiles SET balance = balance - v_final_price WHERE id = v_effective_user_id;

    INSERT INTO public.activations (user_id, chip_id, service, service_name, price, phone_number, status)
    VALUES (v_effective_user_id, v_chip.id, p_service, p_service_name, v_final_price, v_phone_display, 'waiting')
    RETURNING id INTO v_activation_id;

    INSERT INTO public.transactions (user_id, activation_id, type, amount, description)
    VALUES (v_effective_user_id, v_activation_id, 'debit', v_final_price, 'SMS: ' || p_service_name);

    RETURN jsonb_build_object(
        'ok', true,
        'activation_id', v_activation_id,
        'numero', v_phone_display,
        'preco_aplicado', v_final_price,
        'desconto_aplicado', v_discount
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_solicitar_sms_v3(UUID, TEXT, TEXT, NUMERIC) TO authenticated;

-- Estoque (mesma lógica de status que a compra)
CREATE OR REPLACE FUNCTION public.rpc_get_service_stocks()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_result JSONB;
BEGIN
    SELECT jsonb_object_agg(sid, n) INTO v_result
    FROM (
        SELECT
            s.id::text AS sid,
            (
                SELECT count(*)::INT
                FROM public.chips c
                JOIN public.polos p ON c.polo_id = p.id
                WHERE COALESCE(c.chip_service_off ->> lower(trim(s.id::text)), 'false') <> 'true'
                  AND (c.numero::text IS NULL OR c.numero::text NOT ILIKE 'CCID%')
                  AND lower(trim(c.status::text)) = 'online'
                  AND c.last_ping > NOW() - INTERVAL '3 minutes'
            ) AS n
        FROM (
            SELECT id FROM public.services_config
            UNION
            SELECT DISTINCT service::text AS id FROM public.activations
        ) s
    ) t;

    RETURN COALESCE(v_result, '{}'::JSONB);
END;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_get_service_stocks() TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_get_service_stocks() TO anon;

NOTIFY pgrst, 'reload schema';
