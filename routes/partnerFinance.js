const express = require('express');
const { requirePartnerUser } = require('../middleware/partnerSession');

const router = express.Router();

const MIN_WITHDRAWAL_BRL = 400;
const WITHDRAWAL_FEE_BRL = 5;
const PARTNER_REPASSE_RATE = 0.6; /* 60% fixo sobre valor da venda (SMS recebido) */
const NEW_PARTNER_DAYS = 90;
const HOLD_HOURS_NOVO = 48;
const HOLD_HOURS_ANTIGO = 24;

function round2(n) {
    return Math.round(Number(n) * 100) / 100;
}

router.use(requirePartnerUser);

/** Cálculo interno (incl. saque_prioritario). Nunca exposto ao parceiro na API. */
function effectiveHoldHours(partnerProfile) {
    if (partnerProfile.saque_prioritario) return 0;
    const created = new Date(partnerProfile.created_at).getTime();
    const ageMs = Date.now() - created;
    const isNovo = ageMs < NEW_PARTNER_DAYS * 24 * 60 * 60 * 1000;
    return isNovo ? HOLD_HOURS_NOVO : HOLD_HOURS_ANTIGO;
}

async function loadActivationCredits(supabase, partnerId) {
    const { data: polos, error: polosErr } = await supabase
        .from('polos')
        .select('id')
        .eq('partner_profile_id', partnerId);

    if (polosErr) throw new Error(polosErr.message);
    const poloIds = (polos || []).map((p) => p.id).filter(Boolean);
    if (poloIds.length === 0) return [];

    const { data: chips, error: chipsErr } = await supabase
        .from('chips')
        .select('id')
        .in('polo_id', poloIds);

    if (chipsErr) throw new Error(chipsErr.message);
    const chipIds = (chips || []).map((c) => c.id).filter(Boolean);
    if (chipIds.length === 0) return [];

    const { data: acts, error: actErr } = await supabase
        .from('activations')
        .select('price, updated_at')
        .eq('status', 'received')
        .in('chip_id', chipIds);

    if (actErr) throw new Error(actErr.message);
    return acts || [];
}

async function loadReservedWithdrawals(supabase, partnerId) {
    const { data: rows, error } = await supabase
        .from('partner_withdrawal_requests')
        .select('amount, status')
        .eq('partner_id', partnerId)
        .in('status', ['pending', 'approved']);

    if (error) throw new Error(error.message);
    let sum = 0;
    (rows || []).forEach((r) => {
        sum += Number(r.amount || 0);
    });
    return round2(sum);
}

/** Resposta pública do parceiro: sem campos internos (ex.: saque_prioritario). */
function partnerFacingRules(base) {
    return {
        min_withdrawal_brl: base.min_withdrawal_brl,
        withdrawal_fee_brl: base.withdrawal_fee_brl,
        hold_hours_novo: base.hold_hours_novo,
        hold_hours_antigo: base.hold_hours_antigo,
        novo_period_days: base.novo_period_days,
        is_novo_parceiro: base.is_novo_parceiro,
        repasse_percent: 60
    };
}

async function buildFinanceSummary(supabase, partnerProfile) {
    const margin = PARTNER_REPASSE_RATE;
    const holdHours = effectiveHoldHours(partnerProfile);
    const createdMs = new Date(partnerProfile.created_at).getTime();
    const isNovoParceiro = Date.now() - createdMs < NEW_PARTNER_DAYS * 24 * 60 * 60 * 1000;

    const acts = await loadActivationCredits(supabase, partnerProfile.id);
    const now = Date.now();
    const holdMs = holdHours * 60 * 60 * 1000;

    let repasseTotal = 0;
    let repasseLiberado = 0;
    let repasseEmCarencia = 0;

    acts.forEach((a) => {
        const cut = round2(Number(a.price || 0) * margin);
        if (cut <= 0) return;
        repasseTotal = round2(repasseTotal + cut);
        const creditAt = new Date(a.updated_at).getTime();
        if (holdHours === 0 || creditAt + holdMs <= now) {
            repasseLiberado = round2(repasseLiberado + cut);
        } else {
            repasseEmCarencia = round2(repasseEmCarencia + cut);
        }
    });

    const saquesReservados = await loadReservedWithdrawals(supabase, partnerProfile.id);
    const disponivelParaSolicitar = round2(Math.max(0, repasseLiberado - saquesReservados));

    const internalRules = {
        min_withdrawal_brl: MIN_WITHDRAWAL_BRL,
        withdrawal_fee_brl: WITHDRAWAL_FEE_BRL,
        hold_hours_novo: HOLD_HOURS_NOVO,
        hold_hours_antigo: HOLD_HOURS_ANTIGO,
        novo_period_days: NEW_PARTNER_DAYS,
        is_novo_parceiro: isNovoParceiro
    };

    return {
        rules: partnerFacingRules(internalRules),
        totals: {
            repasse_total: repasseTotal,
            repasse_liberado: repasseLiberado,
            repasse_em_carencia: repasseEmCarencia,
            saques_pendentes_ou_aprovados: saquesReservados,
            disponivel_para_solicitar: disponivelParaSolicitar
        }
    };
}

/**
 * GET /api/partner/finance/summary
 */
router.get('/summary', async (req, res) => {
    const supabase = req.app.get('supabase');
    try {
        const summary = await buildFinanceSummary(supabase, req.partnerProfile);
        return res.json({ ok: true, ...summary });
    } catch (err) {
        return res.status(500).json({ ok: false, error: 'summary_failed', detail: err.message });
    }
});

/**
 * POST /api/partner/finance/withdraw
 * body: { amount: number (bruto retirado do repasse), pix_destination?: string }
 * Taxa fixa R$ 5 — valor líquido a pagar = amount - 5 (registado em net_amount).
 */
router.post('/withdraw', async (req, res) => {
    const supabase = req.app.get('supabase');
    const raw = req.body && req.body.amount;
    const amount = round2(typeof raw === 'string' ? parseFloat(raw) : Number(raw));
    const pixDestination = req.body && req.body.pix_destination != null
        ? String(req.body.pix_destination).trim().slice(0, 500)
        : null;

    if (!Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({ ok: false, error: 'invalid_amount' });
    }
    if (amount < MIN_WITHDRAWAL_BRL) {
        return res.status(400).json({
            ok: false,
            error: 'below_minimum',
            min_brl: MIN_WITHDRAWAL_BRL
        });
    }
    if (amount <= WITHDRAWAL_FEE_BRL) {
        return res.status(400).json({
            ok: false,
            error: 'amount_must_exceed_fee',
            fee_brl: WITHDRAWAL_FEE_BRL
        });
    }

    const netAmount = round2(amount - WITHDRAWAL_FEE_BRL);

    try {
        const summary = await buildFinanceSummary(supabase, req.partnerProfile);
        const disponivel = summary.totals.disponivel_para_solicitar;
        if (amount > disponivel) {
            return res.status(400).json({
                ok: false,
                error: 'insufficient_released_balance',
                disponivel_para_solicitar: disponivel
            });
        }

        const { data: row, error: insErr } = await supabase
            .from('partner_withdrawal_requests')
            .insert({
                partner_id: req.partnerProfile.id,
                user_id: req.partnerUserId,
                amount,
                fee_brl: WITHDRAWAL_FEE_BRL,
                net_amount: netAmount,
                pix_destination: pixDestination || null,
                status: 'pending'
            })
            .select('id, amount, fee_brl, net_amount, status, created_at')
            .maybeSingle();

        if (insErr) {
            return res.status(500).json({ ok: false, error: 'insert_failed', detail: insErr.message });
        }

        return res.status(201).json({
            ok: true,
            withdrawal: row,
            message: 'Pedido registado. O financeiro FluxSMS processará o pagamento do valor líquido após validação (taxa de processamento já considerada).'
        });
    } catch (err) {
        return res.status(500).json({ ok: false, error: 'withdraw_failed', detail: err.message });
    }
});

module.exports = router;
module.exports.buildFinanceSummary = buildFinanceSummary;
module.exports.MIN_WITHDRAWAL_BRL = MIN_WITHDRAWAL_BRL;
module.exports.WITHDRAWAL_FEE_BRL = WITHDRAWAL_FEE_BRL;
