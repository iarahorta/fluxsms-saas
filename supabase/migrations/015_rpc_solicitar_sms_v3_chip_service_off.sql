-- Atualiza rpc_solicitar_sms_v3 para respeitar chip_service_off por serviço
-- (ex.: WhatsApp “queimado” para novas vendas daquele serviço, mantendo outros serviços)

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
    v_balance NUMERIC;
    v_total_recharged NUMERIC;
    v_fidelity_level TEXT;
    v_chip RECORD;
    v_activation_id UUID;
    v_base_price NUMERIC;
    v_final_price NUMERIC;
    v_discount NUMERIC := 0;
    v_lab_polo_id UUID := 'ba768131-e67e-4299-bf5a-96503f92076c';
    v_service_key TEXT := lower(trim(p_service));
BEGIN
    SELECT COALESCE(
        (SELECT price FROM public.custom_prices WHERE user_id = p_user_id AND service = p_service),
        p_default_price
    ) INTO v_base_price;

    PERFORM public.rpc_refresh_fidelity_level(p_user_id);

    SELECT balance, COALESCE(total_recharged, 0), COALESCE(fidelity_level, 'BRONZE')
    INTO v_balance, v_total_recharged, v_fidelity_level
    FROM public.profiles
    WHERE id = p_user_id
    FOR UPDATE;

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
    WHERE p.status = 'ONLINE'
      AND (
          p.ultima_comunicacao > NOW() - INTERVAL '90 seconds'
          OR p.id = v_lab_polo_id
      )
      AND COALESCE(c.chip_service_off ->> v_service_key, 'false') <> 'true'
      AND (
          (p_service = 'whatsapp'
              AND c.status = 'idle'
              AND (c.disponivel_em IS NULL OR c.disponivel_em <= NOW()))
          OR (p_service <> 'whatsapp'
              AND c.status IN ('idle', 'quarentena')
              AND NOT EXISTS (
                  SELECT 1
                  FROM public.activations act
                  WHERE act.chip_id = c.id
                    AND act.service = p_service
                    AND act.status = 'received'
              ))
      )
    ORDER BY (
        SELECT count(*)
        FROM public.activations a2
        JOIN public.chips c2 ON a2.chip_id = c2.id
        WHERE c2.polo_id = p.id
          AND a2.status IN ('pending', 'waiting')
    ) ASC, random()
    LIMIT 1
    FOR UPDATE SKIP LOCKED;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'sem_chips');
    END IF;

    UPDATE public.chips SET status = 'busy' WHERE id = v_chip.id;
    UPDATE public.profiles SET balance = balance - v_final_price WHERE id = p_user_id;

    INSERT INTO public.activations (user_id, chip_id, service, service_name, price, phone_number, status)
    VALUES (p_user_id, v_chip.id, p_service, p_service_name, v_final_price, COALESCE(v_chip.numero, 'AGUARDANDO'), 'waiting')
    RETURNING id INTO v_activation_id;

    INSERT INTO public.transactions (user_id, activation_id, type, amount, description)
    VALUES (p_user_id, v_activation_id, 'debit', v_final_price, 'SMS: ' || p_service_name);

    RETURN jsonb_build_object(
        'ok', true,
        'activation_id', v_activation_id,
        'numero', v_chip.numero,
        'preco_aplicado', v_final_price,
        'desconto_aplicado', v_discount
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_solicitar_sms_v3(UUID, TEXT, TEXT, NUMERIC) TO authenticated;
