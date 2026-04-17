const express = require('express');
const crypto  = require('crypto');
const router  = express.Router();
const _axios  = require('axios');

const MP_API = 'https://api.mercadopago.com';

// ─── Helper MP com Access Token sempre do ambiente ───────────
function mpAxios() {
    return _axios.create({
        baseURL: MP_API,
        headers: { Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}` },
        timeout: 8000
    });
}

/**
 * Valida a assinatura secreta do Mercado Pago.
 * Garante que a notificação veio de verdade do MP (anti-fraude).
 * Documentação: https://www.mercadopago.com.br/developers/pt/docs/your-integrations/notifications/webhooks
 */
function validarAssinaturaMP(req) {
    const secret = process.env.MP_WEBHOOK_SECRET;
    if (!secret) return true; // Se não configurado, pula validação (apenas em dev)

    const xSignature  = req.headers['x-signature'] || '';
    const xRequestId  = req.headers['x-request-id'] || '';
    const dataId      = req.query['data.id'] || req.body?.data?.id || '';

    // Extrai ts e v1 do header x-signature
    const parts = {};
    xSignature.split(',').forEach(part => {
        const [k, v] = part.trim().split('=');
        if (k && v) parts[k] = v;
    });

    const { ts, v1 } = parts;
    if (!ts || !v1) return false;

    // Monta o template da assinatura conforme documentação MP
    const template = `id:${dataId};request-id:${xRequestId};ts:${ts};`;
    const hmac = crypto.createHmac('sha256', secret).update(template).digest('hex');

    return hmac === v1;
}

/**
 * POST /webhook/mercadopago
 * Recebe notificações de pagamento e credita saldo via RPC.
 */
router.post('/mercadopago', async (req, res) => {
    const supabase = req.app.get('supabase');

    // ─── Valida assinatura secreta do MP (anti-fraude) ────────
    if (!validarAssinaturaMP(req)) {
        console.warn('[WEBHOOK MP] Assinatura inválida — requisição rejeitada');
        console.debug('[WEBHOOK MP] Headers:', JSON.stringify(req.headers));
        console.debug('[WEBHOOK MP] Body:', JSON.stringify(req.body));
        return res.status(401).json({ error: 'invalid_signature' });
    }

    try {
        const { type, data } = req.body;
        if (type !== 'payment' || !data?.id) {
            return res.status(200).json({ ok: true, msg: 'ignored' });
        }

        const paymentId = String(data.id);

        // Valida o pagamento na API oficial (nunca confiar só no body)
        const { data: payment } = await mpAxios().get(`/v1/payments/${paymentId}`);

        const status = payment.status;
        const amount = parseFloat(payment.transaction_amount);
        const userId = payment.metadata?.user_id;

        if (!userId) {
            console.warn('[WEBHOOK MP] Pagamento sem user_id no metadata:', paymentId);
            return res.status(200).json({ ok: true, msg: 'no_user_id' });
        }

        const { data: rpcResult, error } = await supabase.rpc('rpc_creditar_saldo', {
            p_user_id:       userId,
            p_amount:        amount,
            p_mp_payment_id: paymentId,
            p_mp_status:     status
        });

        if (error) {
            console.error('[WEBHOOK MP] Erro RPC:', error.message);
            return res.status(500).json({ ok: false });
        }

        console.log(`[WEBHOOK MP] ${paymentId} | ${status} | R$ ${amount} | user: ${userId}`);
        return res.status(200).json({ ok: true, result: rpcResult });

    } catch (err) {
        const detail = err.response?.data || err.message;
        console.error('[WEBHOOK MP] Falha crítica:', detail);
        return res.status(500).json({ ok: false, error: err.message });
    }
});

/**
 * POST /webhook/criar-pix
 * Gera um QR Code Pix via Mercado Pago com user_id no metadata.
 * Chamado pelo frontend quando usuário clica em "Gerar Pix".
 * Requer: Authorization Bearer (token Supabase do usuário)
 */
router.post('/criar-pix', async (req, res) => {
    const supabase = req.app.get('supabase');

    // Autentica o usuário via token Supabase
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'unauthorized' });

    const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !user) return res.status(401).json({ error: 'invalid_token' });

    const { amount } = req.body;
    if (!amount || amount < 5) return res.status(400).json({ error: 'Valor mínimo R$ 5,00' });

    try {
        console.log(`[CRIAR PIX] User: ${user.id} | Amount: ${amount}`);

        const response = await _axios.post(`${MP_API}/v1/payments`, {
            transaction_amount: parseFloat(amount),
            description: `FluxSMS - Recarga de saldo R$ ${amount}`,
            payment_method_id: 'pix',
            payer: { email: user.email },
            metadata: { user_id: user.id } 
        }, {
            headers: {
                'Authorization': `Bearer ${process.env.MP_ACCESS_TOKEN}`,
                'X-Idempotency-Key': crypto.randomBytes(16).toString('hex'),
                'Content-Type': 'application/json'
            },
            timeout: 10000
        });

        const preference = response.data;

        return res.status(200).json({
            ok: true,
            payment_id:  preference.id,
            qr_code:     preference.point_of_interaction?.transaction_data?.qr_code,
            qr_code_b64: preference.point_of_interaction?.transaction_data?.qr_code_base64,
            expires_at:  preference.date_of_expiration
        });

    } catch (err) {
        const mpError = err.response?.data;
        console.error('[CRIAR PIX] Erro:', JSON.stringify(mpError) || err.message);
        
        // Retornamos mais detalhes para o frontend conseguir debugar na tela
        return res.status(500).json({ 
            ok: false,
            error: mpError?.message || 'Erro ao criar Pix', 
            details: mpError?.cause || err.message 
        });
    }
});

module.exports = router;
