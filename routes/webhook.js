const express = require('express');
const crypto  = require('crypto');
const router  = express.Router();
const axios   = require('axios');
const nexusPag = require('../lib/nexusPag');
const { validateNexusWebhookToken } = require('../lib/nexusWebhookAuth');
const { distributeNexusPixWalletSplit } = require('../lib/nexusDepositWalletSplit');
const { logBalanceAudit, clientIp, ua } = require('../lib/auditLog');
const { pixCreateLimiter, paymentWebhookLimiter } = require('../middleware/rateLimit');

const MP_API = 'https://api.mercadopago.com';

// ─── Helper MP com Access Token sempre do ambiente ───────────
function mpAxios() {
    return axios.create({
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
    if (!secret) {
        // Em produção, exige secret para aceitar webhooks de pagamento.
        return process.env.NODE_ENV !== 'production';
    }

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
 * POST /webhook
 * Recebe notificações de pagamento e credita saldo via RPC.
 */
router.post('/', paymentWebhookLimiter, async (req, res) => {
    console.log('>>>> ALERTA: WEBHOOK RECEBIDO DO MERCADO PAGO <<<<');
    // RESPONDE 200 OK IMEDIATAMENTE (Para evitar 502/Timeout no Mercado Pago)
    res.status(200).send('OK');

    const supabase = req.app.get('supabase');

    // ─── Valida assinatura secreta do MP (anti-fraude) ────────
    if (!validarAssinaturaMP(req)) {
        console.warn('[WEBHOOK MP] Assinatura inválida — ignorando processamento');
        return; 
    }

    try {
        const { type, data } = req.body;
        if (type !== 'payment' || !data?.id) return;

        const paymentId = String(data.id);

        // Valida o pagamento na API oficial (nunca confiar só no body)
        let payment;
        try {
            const resMP = await mpAxios().get(`/v1/payments/${paymentId}`);
            payment = resMP.data;
        } catch (err) {
            console.log(`[WEBHOOK MP] Pagamento ${paymentId} não encontrado ou inválido, ignorando...`);
            return; // Já respondemos 200 no topo
        }

        const status = String(payment.status || '').toLowerCase();
        const amount = parseFloat(payment.transaction_amount);
        
        // Prioriza external_reference (mais estável) e depois metadata
        const userId = payment.external_reference || payment.metadata?.user_id;

        if (!userId) {
            console.warn('[WEBHOOK MP] Pagamento sem user_id no metadata:', paymentId);
            return; // Já respondemos 200 no topo
        }

        // O MP notifica várias vezes (pending / in_process / rejected). Só creditamos quando aprovado.
        if (status !== 'approved') {
            console.log(
                `[WEBHOOK MP] ${paymentId} estado="${payment.status}" — sem crédito ainda (normal até o PIX ser aprovado no MP).`
            );
            return;
        }

        const { data: rpcResult, error } = await supabase.rpc('rpc_creditar_saldo', {
            p_user_id:       userId,
            p_amount:        amount,
            p_mp_payment_id: paymentId,
            p_mp_status:     status
        });

        if (error) {
            console.error('[WEBHOOK MP] Erro RPC:', error.message);
            return; // Já respondemos 200 no topo
        }

        if (rpcResult && rpcResult.ok === false) {
            console.warn('[WEBHOOK MP] RPC recusou crédito após approved:', rpcResult);
            return;
        }

        await logBalanceAudit(supabase, {
            event_type: 'mercadopago_deposit_credit',
            gateway: 'mercadopago',
            external_ref: String(paymentId),
            beneficiary_user_id: userId,
            amount,
            actor_ip: clientIp(req),
            user_agent: ua(req),
            meta: { mp_status: status }
        });

        // Recalcula fidelidade após confirmação de pagamento sem travar o webhook.
        try {
            await supabase.rpc('rpc_refresh_fidelity_level', { p_user_id: userId });
        } catch (_e) { }

        console.log(`[WEBHOOK MP] ${paymentId} | ${status} | R$ ${amount} | user: ${userId}`);

    } catch (err) {
        const detail = err.response?.data || err.message;
        console.error('[WEBHOOK MP] Falha capturada (blindada):', detail);
    }
});

/**
 * POST /webhook/criar-pix
 * Gera um QR Code Pix via Mercado Pago com user_id no metadata.
 * Chamado pelo frontend quando usuário clica em "Gerar Pix".
 * Requer: Authorization Bearer (token Supabase do usuário)
 */
router.post('/criar-pix', pixCreateLimiter, async (req, res) => {
    const supabase = req.app.get('supabase');

    // Autentica o usuário via token Supabase
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'unauthorized' });

    const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !user) return res.status(401).json({ error: 'invalid_token' });

    const { amount } = req.body;
    if (!amount || amount < 20) return res.status(400).json({ error: 'Valor mínimo R$ 20,00' });

    try {
        console.log(`[CRIAR PIX] User: ${user.id} | Amount: ${amount}`);

        const response = await axios.post(`${MP_API}/v1/payments`, {
            transaction_amount: parseFloat(amount),
            description: `FluxSMS - Recarga de saldo R$ ${amount}`,
            payment_method_id: 'pix',
            payer: { email: user.email },
            external_reference: String(user.id),
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
        const mpMsg = typeof mpError === 'object' ? JSON.stringify(mpError) : String(mpError);
        console.error('[CRIAR PIX] Erro capturado:', mpMsg || err.message);
        
        return res.status(500).json({ 
            ok: false,
            error: mpError?.message || 'Erro ao gerar Pix no gateway', 
            details: mpError?.cause || err.message 
        });
    }
});

/**
 * POST /webhook/criar-pix-nexus
 * Gera cobrança PIX dinâmica via NexusPag (x-api-key).
 * Requer: Authorization Bearer (token Supabase do usuário)
 */
router.post('/criar-pix-nexus', pixCreateLimiter, async (req, res) => {
    const supabase = req.app.get('supabase');
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ ok: false, error: 'unauthorized' });

    const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !user) return res.status(401).json({ ok: false, error: 'invalid_token' });

    const raw = req.body && req.body.amount;
    const amount = typeof raw === 'string' ? parseFloat(raw) : Number(raw);
    if (!Number.isFinite(amount) || amount < 20) {
        return res.status(400).json({ ok: false, error: 'Valor mínimo R$ 20,00' });
    }

    const publicBase = String(process.env.PUBLIC_BASE_URL || '').trim()
        || `${req.protocol}://${req.get('host')}`;
    const whTok = String(process.env.NEXUSPAG_WEBHOOK_TOKEN || process.env.NEXUS_PAY_WEBHOOK_TOKEN || '').trim();
    if (!whTok) {
        return res.status(500).json({
            ok: false,
            error: 'nexus_webhook_token_ausente',
            detail: 'Defina NEXUSPAG_WEBHOOK_TOKEN no Railway. O URL do webhook inclui ?token=... para a Nexus validar.'
        });
    }
    const webhookBase = `${publicBase.replace(/\/$/, '')}/webhook/nexus-pix`;
    const webhookUrl = `${webhookBase}?token=${encodeURIComponent(whTok)}`;

    try {
        const externalRef = crypto.randomUUID();
        const { data: ord, error: insErr } = await supabase
            .from('flux_nexus_pix_orders')
            .insert({
                user_id: user.id,
                amount_brl: amount,
                external_ref: externalRef,
                status: 'pending',
                raw_create: {}
            })
            .select('id, external_ref, amount_brl')
            .maybeSingle();

        if (insErr || !ord) {
            return res.status(500).json({ ok: false, error: 'order_create_failed', detail: insErr?.message });
        }

        const created = await nexusPag.createPixCharge({
            amountBrl: amount,
            externalId: ord.external_ref,
            webhookUrl,
            description: `FluxSMS — recarga R$ ${amount.toFixed(2)}`
        });

        const chargeId = nexusPag.extractChargeIdFromCreateResponse(created.data) || null;
        const qr = nexusPag.extractQrFromCreateResponse(created.data);

        await supabase
            .from('flux_nexus_pix_orders')
            .update({
                gateway_charge_id: chargeId,
                raw_create: created.data || {}
            })
            .eq('id', ord.id);

        return res.status(200).json({
            ok: true,
            gateway: 'nexuspag',
            order_id: ord.id,
            external_ref: ord.external_ref,
            charge_id: chargeId,
            qr_code: qr.qr_code,
            qr_code_b64: qr.qr_code_b64,
            raw: process.env.NEXUSPAG_DEBUG === '1' ? created.data : undefined
        });
    } catch (err) {
        const detail = err.response?.data || err.message;
        console.error('[CRIAR PIX NEXUS] Falha:', detail);
        return res.status(500).json({ ok: false, error: 'nexus_pix_failed', detail: String(detail) });
    }
});

/**
 * POST /webhook/nexus-pix
 * Webhook de confirmação (NexusPag). Responde 200 imediatamente.
 */
router.post('/nexus-pix', paymentWebhookLimiter, (req, res) => {
    if (!validateNexusWebhookToken(req)) {
        return res.status(401).json({ ok: false, error: 'webhook_token_invalido' });
    }
    res.status(200).send('OK');
    const supabase = req.app.get('supabase');

    (async () => {
        try {
            const body = req.body || {};
            const chargeId = nexusPag.extractChargeIdFromWebhookBody(body);
            if (!chargeId) {
                console.warn('[WEBHOOK NEXUS] Sem charge id reconhecível');
                return;
            }

            const remote = await nexusPag.getPixCharge(chargeId);
            if (remote.status < 200 || remote.status >= 300) {
                console.warn('[WEBHOOK NEXUS] Consulta PIX falhou:', remote.status);
                return;
            }

            const paidFromApi = nexusPag.extractPaidFromRemote(remote.data);
            const paidFromEvent = nexusPag.extractPaidFromWebhookBody(body);
            const paid = paidFromApi || paidFromEvent;
            const amount = nexusPag.extractAmountFromRemote(remote.data);
            const ext = nexusPag.extractExternalRef(remote.data);

            let ord = null;
            let ordErr = null;
            ({ data: ord, error: ordErr } = await supabase
                .from('flux_nexus_pix_orders')
                .select('id, user_id, amount_brl, external_ref, status')
                .eq('gateway_charge_id', chargeId)
                .maybeSingle());

            if (!ord && ext) {
                ({ data: ord, error: ordErr } = await supabase
                    .from('flux_nexus_pix_orders')
                    .select('id, user_id, amount_brl, external_ref, status')
                    .eq('external_ref', ext)
                    .maybeSingle());
            }

            if (ordErr || !ord) {
                console.warn('[WEBHOOK NEXUS] Pedido local não encontrado:', chargeId, ext || '—');
                return;
            }

            if (!paid) {
                await supabase
                    .from('flux_nexus_pix_orders')
                    .update({ raw_webhook: body, gateway_charge_id: chargeId })
                    .eq('id', ord.id);
                return;
            }

            const creditAmount = Number.isFinite(amount) && amount > 0 ? amount : Number(ord.amount_brl);
            const { data: rpcData, error: rpcErr } = await supabase.rpc('rpc_creditar_saldo_gateway', {
                p_user_id: ord.user_id,
                p_amount: creditAmount,
                p_external_payment_id: String(chargeId),
                p_payment_status: 'paid',
                p_gateway: 'nexuspag'
            });

            if (rpcErr) {
                console.error('[WEBHOOK NEXUS] RPC crédito falhou:', rpcErr.message);
                return;
            }

            if (rpcData && rpcData.error === 'pagamento_ja_processado') {
                return;
            }

            if (rpcData && rpcData.ok === false) {
                console.warn('[WEBHOOK NEXUS] RPC retornou erro lógico:', rpcData);
                return;
            }

            await supabase
                .from('flux_nexus_pix_orders')
                .update({
                    status: 'paid',
                    paid_at: new Date().toISOString(),
                    raw_webhook: body,
                    gateway_charge_id: chargeId
                })
                .eq('id', ord.id);

            try {
                const splitRes = await distributeNexusPixWalletSplit(supabase, {
                    chargeId,
                    amountBrl: creditAmount
                });
                if (splitRes && splitRes.ok && !splitRes.skipped) {
                    console.log('[WEBHOOK NEXUS] split interno aplicado | charge=', chargeId);
                } else if (splitRes && !splitRes.ok) {
                    console.warn('[WEBHOOK NEXUS] split interno falhou:', splitRes.error || splitRes);
                }
            } catch (splitErr) {
                console.warn('[WEBHOOK NEXUS] split interno exceção:', splitErr.message || splitErr);
            }

            await logBalanceAudit(supabase, {
                event_type: 'nexuspag_deposit_credit',
                gateway: 'nexuspag',
                external_ref: String(chargeId),
                beneficiary_user_id: ord.user_id,
                amount: creditAmount,
                actor_ip: clientIp(req),
                user_agent: ua(req),
                meta: { order_id: ord.id, external_ref: ord.external_ref }
            });

            try {
                await supabase.rpc('rpc_refresh_fidelity_level', { p_user_id: ord.user_id });
            } catch (_e) { }

            console.log(`[WEBHOOK NEXUS] pago | charge=${chargeId} | user=${ord.user_id} | R$ ${creditAmount}`);
        } catch (e) {
            console.error('[WEBHOOK NEXUS] erro async:', e.message || e);
        }
    })().catch(() => { });
});

module.exports = router;
