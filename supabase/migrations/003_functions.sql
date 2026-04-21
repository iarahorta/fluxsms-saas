-- ============================================================
-- FluxSMS - Migration 003: RPC Functions (Stored Procedures)
-- SEGURANÇA: Saldo só é alterado por estas funções protegidas
-- ============================================================

-- ─── CRÉDITO DE SALDO (chamada pelo Webhook MP) ──────────────
-- Valida pagamento e só credita se status = 'approved'
CREATE OR REPLACE FUNCTION public.rpc_creditar_saldo(
    p_user_id       UUID,
    p_amount        NUMERIC,
    p_mp_payment_id TEXT,
    p_mp_status     TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER  -- Roda com privilégio do owner, não do chamador
SET search_path = public
AS $$
DECLARE
    v_already_processed BOOLEAN;
BEGIN
    -- Idempotência: verifica se payment_id já foi processado
    SELECT EXISTS(
        SELECT 1 FROM transactions WHERE mp_payment_id = p_mp_payment_id
    ) INTO v_already_processed;

    IF v_already_processed THEN
        RETURN jsonb_build_object('ok', false, 'error', 'pagamento_ja_processado');
    END IF;

    -- Só credita se Mercado Pago confirmou
    IF p_mp_status != 'approved' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'pagamento_nao_aprovado', 'status', p_mp_status);
    END IF;

    -- Credita o saldo
    UPDATE profiles SET balance = balance + p_amount WHERE id = p_user_id;

    -- Registra a transação
    INSERT INTO transactions (user_id, type, amount, description, mp_payment_id, mp_status)
    VALUES (p_user_id, 'credit', p_amount, 'Recarga via Pix', p_mp_payment_id, p_mp_status);

    RETURN jsonb_build_object('ok', true, 'amount_credited', p_amount);
END;
$$;

-- ─── DÉBITO / COMPRA DE SMS ───────────────────────────────────
-- Valida saldo, bloqueia chip e cria ativação atomicamente
-- Protegido contra race condition via FOR UPDATE
CREATE OR REPLACE FUNCTION public.rpc_solicitar_sms(
    p_user_id       UUID,
    p_service       TEXT,
    p_service_name  TEXT,
    p_price         NUMERIC
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_balance       NUMERIC;
    v_chip          RECORD;
    v_activation_id UUID;
    v_phone_number  TEXT;
BEGIN
    -- 1. Verifica saldo (com lock para evitar race condition)
    SELECT balance INTO v_balance
    FROM profiles
    WHERE id = p_user_id
    FOR UPDATE;

    IF v_balance < p_price THEN
        RETURN jsonb_build_object('ok', false, 'error', 'saldo_insuficiente', 'balance', v_balance);
    END IF;

    -- 2. Busca chip disponível (FOR UPDATE garante exclusividade)
    SELECT * INTO v_chip
    FROM chips
    WHERE status = 'idle'
    LIMIT 1
    FOR UPDATE SKIP LOCKED;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'sem_chips_disponiveis');
    END IF;

    -- 3. Simula/usa o número do chip
    v_phone_number := COALESCE(v_chip.numero, '+55 XX XXXX-XXXX');

    -- 4. Marca chip como ocupado
    UPDATE chips SET status = 'busy' WHERE id = v_chip.id;

    -- 5. Debita saldo
    UPDATE profiles SET balance = balance - p_price WHERE id = p_user_id;

    -- 6. Cria ativação
    INSERT INTO activations (user_id, chip_id, service, service_name, price, phone_number, status)
    VALUES (p_user_id, v_chip.id, p_service, p_service_name, p_price, v_phone_number, 'waiting')
    RETURNING id INTO v_activation_id;

    -- 7. Registra transação
    INSERT INTO transactions (user_id, activation_id, type, amount, description)
    VALUES (p_user_id, v_activation_id, 'debit', p_price, 'Compra SMS: ' || p_service_name);

    RETURN jsonb_build_object(
        'ok', true,
        'activation_id', v_activation_id,
        'phone_number', v_phone_number,
        'expires_in', 1200
    );
END;
$$;

-- ─── CANCELAR ATIVAÇÃO ────────────────────────────────────────
-- Reembolsa saldo e libera o chip SE ainda não recebeu SMS
CREATE OR REPLACE FUNCTION public.rpc_cancelar_ativacao(
    p_user_id       UUID,
    p_activation_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_activation RECORD;
    v_refund_amount NUMERIC(10,2);
BEGIN
    -- Busca com lock
    SELECT * INTO v_activation
    FROM activations
    WHERE id = p_activation_id AND user_id = p_user_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'ativacao_nao_encontrada');
    END IF;

    -- TRAVA: Se já recebeu o SMS, não pode cancelar/reembolsar
    IF v_activation.status = 'received' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'sms_ja_recebido_sem_reembolso');
    END IF;

    IF v_activation.status NOT IN ('pending', 'waiting') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'status_invalido_para_cancelamento');
    END IF;

    -- Atualiza status para cancelado
    UPDATE activations SET status = 'cancelled' WHERE id = p_activation_id;

    -- Libera o chip
    UPDATE chips SET status = 'idle' WHERE id = v_activation.chip_id;

    -- Reembolso sempre usa o valor efetivamente debitado (compatível com V3/discount).
    SELECT t.amount INTO v_refund_amount
    FROM transactions t
    WHERE t.activation_id = p_activation_id
      AND t.user_id = p_user_id
      AND t.type = 'debit'
    ORDER BY t.created_at DESC
    LIMIT 1;

    IF v_refund_amount IS NULL THEN
        v_refund_amount := v_activation.price;
    END IF;

    UPDATE profiles SET balance = balance + v_refund_amount WHERE id = p_user_id;

    -- Registra reembolso
    INSERT INTO transactions (user_id, activation_id, type, amount, description)
    VALUES (p_user_id, p_activation_id, 'refund', v_refund_amount, 'Reembolso: ' || v_activation.service_name);

    RETURN jsonb_build_object('ok', true, 'refunded', v_refund_amount);
END;
$$;

-- ─── PERMISSÕES ───────────────────────────────────────────────
-- Funções chamáveis por usuários autenticados via frontend
GRANT EXECUTE ON FUNCTION public.rpc_solicitar_sms    TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_cancelar_ativacao TO authenticated;
-- Crédito: apenas service_role (backend/webhook)
GRANT EXECUTE ON FUNCTION public.rpc_creditar_saldo    TO service_role;
