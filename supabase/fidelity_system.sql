-- ============================================================
-- FLUXSMS: Módulo de Fidelidade Automática
-- Dia 2 (Operação 72h) - Isolado de outras versões
-- ============================================================

-- 1. Coluna de Acúmulo de Recargas
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS total_recharged NUMERIC(10, 2) NOT NULL DEFAULT 0.00;

-- Sincronizar recargas antigas
UPDATE public.profiles p
SET total_recharged = COALESCE((
    SELECT SUM(amount) FROM public.transactions t 
    WHERE t.user_id = p.id AND t.type = 'credit'
), 0);

-- 2. Trigger para automatizar soma das novas recargas (Aprovações PIX)
CREATE OR REPLACE FUNCTION update_total_recharged_after_credit()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.type = 'credit' THEN
        UPDATE public.profiles
        SET total_recharged = total_recharged + NEW.amount
        WHERE id = NEW.user_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_update_total_recharged ON public.transactions;
CREATE TRIGGER trg_update_total_recharged
AFTER INSERT ON public.transactions
FOR EACH ROW
EXECUTE FUNCTION update_total_recharged_after_credit();

-- 3. Função Isolada e Blindada para V3 (Calcula desconto automático)
CREATE OR REPLACE FUNCTION public.rpc_solicitar_sms_v3(
    p_user_id UUID, p_service TEXT, p_service_name TEXT, p_default_price NUMERIC
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE 
    v_balance NUMERIC; 
    v_total_recharged NUMERIC;
    v_chip RECORD; 
    v_activation_id UUID; 
    v_base_price NUMERIC;
    v_final_price NUMERIC;
    v_discount NUMERIC := 0;
    v_lab_polo_id UUID := 'ba768131-e67e-4299-bf5a-96503f92076c';
BEGIN
    -- Determina o preço base (tabela custom_prices ou default)
    SELECT COALESCE((SELECT price FROM custom_prices WHERE user_id = p_user_id AND service = p_service), p_default_price) 
    INTO v_base_price;

    -- Extrai saldo e total recarregado com Lock
    SELECT balance, COALESCE(total_recharged, 0) INTO v_balance, v_total_recharged FROM profiles WHERE id = p_user_id FOR UPDATE;
    
    -- Cálcula Desconto via Nível de Fidelidade (HeroSMS logic)
    IF v_total_recharged >= 5000 THEN
        v_discount := 0.40; -- Diamante (40%)
    ELSIF v_total_recharged >= 1000 THEN
        v_discount := 0.25; -- Ouro (25%)
    ELSIF v_total_recharged >= 200 THEN
        v_discount := 0.10; -- Prata (10%)
    END IF;

    v_final_price := ROUND(v_base_price * (1.0 - v_discount), 2);

    IF v_balance < v_final_price THEN 
        RETURN jsonb_build_object('ok',false,'error','saldo_insuficiente','saldo',v_balance, 'preco_final', v_final_price); 
    END IF;
    
    -- Busca chip seguro (quarentena WhatsApp 30d via disponivel_em; Telegram etc. aceitam status quarentena)
    SELECT c.* INTO v_chip
    FROM public.chips c
    JOIN public.polos p ON c.polo_id = p.id
    WHERE p.status = 'ONLINE'
    AND (
        p.ultima_comunicacao > NOW() - INTERVAL '90 seconds'
        OR p.id = v_lab_polo_id
    )
    AND (
        (p_service = 'whatsapp'
            AND c.status = 'idle'
            AND (c.disponivel_em IS NULL OR c.disponivel_em <= NOW()))
        OR (p_service <> 'whatsapp'
            AND c.status IN ('idle', 'quarentena')
            AND NOT EXISTS (
                SELECT 1 FROM public.activations act
                WHERE act.chip_id = c.id
                  AND act.service = p_service
                  AND act.status = 'received'
            ))
    )
    ORDER BY (
        SELECT COUNT(*) FROM public.activations a2
        JOIN public.chips c2 ON a2.chip_id = c2.id
        WHERE c2.polo_id = p.id
          AND a2.status IN ('pending', 'waiting')
    ) ASC, random()
    LIMIT 1 FOR UPDATE SKIP LOCKED;
    
    IF NOT FOUND THEN 
        RETURN jsonb_build_object('ok',false,'error','sem_chips'); 
    END IF;
    
    UPDATE public.chips SET status = 'busy' WHERE id = v_chip.id;
    UPDATE public.profiles SET balance = balance - v_final_price WHERE id = p_user_id;
    INSERT INTO public.activations (user_id, chip_id, service, service_name, price, phone_number, status)
    VALUES (p_user_id, v_chip.id, p_service, p_service_name, v_final_price, COALESCE(v_chip.numero, 'AGUARDANDO'), 'waiting')
    RETURNING id INTO v_activation_id;
    
    INSERT INTO public.transactions (user_id, activation_id, type, amount, description)
    VALUES (p_user_id, v_activation_id, 'debit', v_final_price, 'SMS: ' || p_service_name);
    
    RETURN jsonb_build_object('ok',true, 'activation_id', v_activation_id, 'numero', v_chip.numero, 'preco_aplicado', v_final_price, 'desconto_aplicado', v_discount);
END; $$;

GRANT EXECUTE ON FUNCTION public.rpc_solicitar_sms_v3 TO authenticated;
