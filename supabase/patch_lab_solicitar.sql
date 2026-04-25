-- Versão corrigida: sem LEFT JOIN + GROUP BY (incompatível com FOR UPDATE SKIP LOCKED)
-- Usa subquery correlacionada no ORDER BY para load balancing
CREATE OR REPLACE FUNCTION public.rpc_solicitar_sms_v2(
    p_user_id UUID, p_service TEXT, p_service_name TEXT, p_default_price NUMERIC
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE 
    v_balance NUMERIC; 
    v_chip RECORD; 
    v_activation_id UUID; 
    v_final_price NUMERIC;
    v_lab_polo_id UUID := 'ba768131-e67e-4299-bf5a-96503f92076c';
BEGIN
    SELECT COALESCE((SELECT price FROM custom_prices WHERE user_id = p_user_id AND service = p_service), p_default_price) 
    INTO v_final_price;

    SELECT balance INTO v_balance FROM profiles WHERE id = p_user_id FOR UPDATE;
    IF v_balance < v_final_price THEN 
        RETURN jsonb_build_object('ok',false,'error','saldo_insuficiente','saldo',v_balance); 
    END IF;
    
    SELECT c.* INTO v_chip 
    FROM chips c
    JOIN polos p ON c.polo_id = p.id
    WHERE c.status = 'idle'
    AND p.status = 'ONLINE'
    AND (
        p.ultima_comunicacao > NOW() - INTERVAL '90 seconds'
        OR p.id = v_lab_polo_id
    )
    AND NOT EXISTS (
        SELECT 1 FROM activations act
        WHERE act.chip_id = c.id
        AND act.service = p_service
        AND act.status = 'received'
    )
    ORDER BY (
        SELECT COUNT(*) FROM activations a2
        JOIN chips c2 ON a2.chip_id = c2.id
        WHERE c2.polo_id = p.id
        AND a2.status IN ('pending', 'waiting')
    ) ASC, random()
    LIMIT 1 FOR UPDATE SKIP LOCKED;
    
    IF NOT FOUND THEN 
        RETURN jsonb_build_object('ok',false,'error','sem_chips'); 
    END IF;
    
    UPDATE chips SET status='busy' WHERE id = v_chip.id;
    UPDATE profiles SET balance = balance - v_final_price WHERE id = p_user_id;
    INSERT INTO activations (user_id,chip_id,service,service_name,price,phone_number,status)
    VALUES (p_user_id, v_chip.id, p_service, p_service_name, v_final_price, COALESCE(v_chip.numero,'AGUARDANDO'), 'waiting')
    RETURNING id INTO v_activation_id;
    
    INSERT INTO transactions (user_id, activation_id, type, amount, description)
    VALUES (p_user_id, v_activation_id, 'debit', v_final_price, 'SMS: '||p_service_name);
    
    RETURN jsonb_build_object('ok',true, 'activation_id', v_activation_id, 'numero', v_chip.numero, 'preco_aplicado', v_final_price);
END; $$;
