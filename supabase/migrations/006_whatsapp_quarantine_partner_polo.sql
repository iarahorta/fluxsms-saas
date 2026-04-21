-- ============================================================
-- FluxSMS 006: Quarentena WhatsApp (30 dias) + vínculo Polo→Parceiro
-- Execute no Supabase SQL Editor (ou via CLI migrations).
-- ============================================================

-- 1) Chips: data em que o chip volta a poder vender WhatsApp
ALTER TABLE public.chips
    ADD COLUMN IF NOT EXISTS disponivel_em TIMESTAMPTZ;

COMMENT ON COLUMN public.chips.disponivel_em IS 'Após venda WhatsApp recebida: até quando o chip fica bloqueado para novo WhatsApp (30 dias).';

-- 2) Status: inclui quarentena (bloqueio só para WhatsApp; outros serviços seguem usando o chip)
ALTER TABLE public.chips DROP CONSTRAINT IF EXISTS chips_status_check;
ALTER TABLE public.chips
    ADD CONSTRAINT chips_status_check
    CHECK (status IN ('idle', 'busy', 'offline', 'quarentena'));

-- 3) Polo opcionalmente atribuído a um parceiro (para métricas no painel admin)
ALTER TABLE public.polos
    ADD COLUMN IF NOT EXISTS partner_profile_id UUID REFERENCES public.partner_profiles(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_polos_partner_profile_id ON public.polos(partner_profile_id);

-- Recria funções sem conflito de tipo/assinatura (evita ERROR 42P13)
DROP FUNCTION IF EXISTS public.rpc_get_service_stocks() CASCADE;
DROP FUNCTION IF EXISTS public.rpc_monitorar_e_estornar_v2() CASCADE;
DROP FUNCTION IF EXISTS public.rpc_cancelar_ativacao(UUID, UUID) CASCADE;
DROP FUNCTION IF EXISTS public.rpc_solicitar_sms_v3(UUID, TEXT, TEXT, NUMERIC) CASCADE;

-- 4) Impede "subir" chip com mesmo número enquanto outro registro ainda em quarentena WhatsApp
CREATE OR REPLACE FUNCTION public.trg_chips_valida_quarentena_numero()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
    v_conflict_until TIMESTAMPTZ;
    v_norm TEXT;
BEGIN
    IF NEW.numero IS NULL OR btrim(NEW.numero) = '' THEN
        RETURN NEW;
    END IF;

    v_norm := regexp_replace(lower(btrim(NEW.numero)), '\s+', '', 'g');

    SELECT MAX(c.disponivel_em) INTO v_conflict_until
    FROM public.chips c
    WHERE c.id IS DISTINCT FROM NEW.id
      AND c.numero IS NOT NULL
      AND btrim(c.numero) <> ''
      AND regexp_replace(lower(btrim(c.numero)), '\s+', '', 'g') = v_norm
      AND c.disponivel_em IS NOT NULL
      AND c.disponivel_em > NOW();

    IF v_conflict_until IS NOT NULL THEN
        RAISE EXCEPTION 'Em Quarentena (WhatsApp) até %', to_char(v_conflict_until AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI')
            USING ERRCODE = 'P0001';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_chips_valida_quarentena_numero ON public.chips;
CREATE TRIGGER trg_chips_valida_quarentena_numero
    BEFORE INSERT OR UPDATE OF numero ON public.chips
    FOR EACH ROW EXECUTE FUNCTION public.trg_chips_valida_quarentena_numero();

-- 5) Libera quarentena WhatsApp quando o prazo passa (chamado pelo Gari existente no frontend)
CREATE OR REPLACE FUNCTION public.rpc_monitorar_e_estornar_v2()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_rec RECORD;
    v_refund_amount NUMERIC(10, 2);
    v_count_polos INT := 0;
    v_count_refunds INT := 0;
    v_quar_released INT := 0;
BEGIN
    UPDATE public.polos
    SET status = 'OFFLINE'
    WHERE (ultima_comunicacao < NOW() - INTERVAL '90 seconds' OR ultima_comunicacao IS NULL)
      AND status <> 'OFFLINE';
    GET DIAGNOSTICS v_count_polos = ROW_COUNT;

    FOR v_rec IN
        SELECT a.id, a.user_id, a.price, a.service_name
        FROM public.activations a
        JOIN public.chips c ON a.chip_id = c.id
        JOIN public.polos p ON c.polo_id = p.id
        WHERE p.status = 'OFFLINE'
          AND a.status IN ('pending', 'waiting')
    LOOP
        SELECT t.amount INTO v_refund_amount
        FROM public.transactions t
        WHERE t.activation_id = v_rec.id
          AND t.user_id = v_rec.user_id
          AND t.type = 'debit'
        ORDER BY t.created_at DESC
        LIMIT 1;

        IF v_refund_amount IS NULL THEN
            v_refund_amount := v_rec.price;
        END IF;

        UPDATE public.profiles SET balance = balance + v_refund_amount WHERE id = v_rec.user_id;
        UPDATE public.activations SET status = 'expired', updated_at = NOW() WHERE id = v_rec.id;
        INSERT INTO public.transactions (user_id, activation_id, type, amount, description)
        VALUES (v_rec.user_id, v_rec.id, 'refund', v_refund_amount, 'Estorno: Polo Offline (' || v_rec.service_name || ')');
        v_count_refunds := v_count_refunds + 1;
    END LOOP;

    UPDATE public.chips
    SET status = 'idle',
        disponivel_em = NULL
    WHERE status = 'quarentena'
      AND disponivel_em IS NOT NULL
      AND disponivel_em <= NOW();
    GET DIAGNOSTICS v_quar_released = ROW_COUNT;

    RETURN jsonb_build_object(
        'ok', true,
        'polos_offline', v_count_polos,
        'estornos_realizados', v_count_refunds,
        'whatsapp_quarentena_liberados', v_quar_released
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_monitorar_e_estornar_v2() TO authenticated;

-- 6) Cancelamento: devolve chip ao estado correto (mantém quarentena WhatsApp se ainda vigente)
CREATE OR REPLACE FUNCTION public.rpc_cancelar_ativacao(
    p_user_id UUID,
    p_activation_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_activation RECORD;
    v_refund_amount NUMERIC(10, 2);
BEGIN
    SELECT * INTO v_activation
    FROM public.activations
    WHERE id = p_activation_id AND user_id = p_user_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'ativacao_nao_encontrada');
    END IF;

    IF v_activation.status = 'received' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'sms_ja_recebido_sem_reembolso');
    END IF;

    IF v_activation.status NOT IN ('pending', 'waiting') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'status_invalido_para_cancelamento');
    END IF;

    UPDATE public.activations SET status = 'cancelled' WHERE id = p_activation_id;

    UPDATE public.chips c
    SET
        status = CASE
            WHEN c.disponivel_em IS NOT NULL AND c.disponivel_em > NOW() THEN 'quarentena'
            ELSE 'idle'
        END
    WHERE c.id = v_activation.chip_id;

    SELECT t.amount INTO v_refund_amount
    FROM public.transactions t
    WHERE t.activation_id = p_activation_id
      AND t.user_id = p_user_id
      AND t.type = 'debit'
    ORDER BY t.created_at DESC
    LIMIT 1;

    IF v_refund_amount IS NULL THEN
        v_refund_amount := v_activation.price;
    END IF;

    UPDATE public.profiles SET balance = balance + v_refund_amount WHERE id = p_user_id;

    INSERT INTO public.transactions (user_id, activation_id, type, amount, description)
    VALUES (p_user_id, p_activation_id, 'refund', v_refund_amount, 'Reembolso: ' || v_activation.service_name);

    RETURN jsonb_build_object('ok', true, 'refunded', v_refund_amount);
END;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_cancelar_ativacao(UUID, UUID) TO authenticated;

-- 7) Estoque por serviço: WhatsApp respeita disponivel_em; demais serviços aceitam chip em quarentena
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
                    SELECT 1
                    FROM public.activations a
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
GRANT EXECUTE ON FUNCTION public.rpc_get_service_stocks() TO anon;

-- 8) Solicitar SMS V3: seleção de chip alinhada à quarentena WhatsApp
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
    v_chip RECORD;
    v_activation_id UUID;
    v_base_price NUMERIC;
    v_final_price NUMERIC;
    v_discount NUMERIC := 0;
    v_lab_polo_id UUID := 'ba768131-e67e-4299-bf5a-96503f92076c';
BEGIN
    SELECT COALESCE(
        (SELECT price FROM public.custom_prices WHERE user_id = p_user_id AND service = p_service),
        p_default_price
    ) INTO v_base_price;

    SELECT balance, COALESCE(total_recharged, 0)
    INTO v_balance, v_total_recharged
    FROM public.profiles
    WHERE id = p_user_id
    FOR UPDATE;

    IF v_total_recharged >= 5000 THEN
        v_discount := 0.40;
    ELSIF v_total_recharged >= 1000 THEN
        v_discount := 0.25;
    ELSIF v_total_recharged >= 200 THEN
        v_discount := 0.10;
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
