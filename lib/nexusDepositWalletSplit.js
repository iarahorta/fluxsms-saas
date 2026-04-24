/**
 * Após PIX Nexus confirmado: regista a divisão interna nas carteiras virtuais (idempotente).
 * A Nexus não envia splits no payload; aplicamos percentuais no nosso DB.
 * O utilizador continua a receber o valor integral em profiles.balance (rpc_creditar_saldo_gateway).
 * Estas entradas são contabilidade interna (wallets + ledger), com ref única por cobrança.
 *
 * Percentuais default: 60% + 13% + 13% + resto (14%) — slugs configuráveis por env.
 */

function round2(n) {
    return Math.round(Number(n) * 100) / 100;
}

function pct(name, fallback) {
    const v = Number.parseFloat(String(process.env[name] || ''));
    if (!Number.isFinite(v) || v < 0) return fallback;
    if (v > 1) {
        if (v > 100) return fallback;
        return v / 100;
    }
    return v;
}

async function distributeNexusPixWalletSplit(supabase, { chargeId, amountBrl }) {
    const id = String(chargeId || '').trim();
    if (!id) return { ok: false, error: 'missing_charge_id' };

    const total = round2(Number(amountBrl));
    if (!Number.isFinite(total) || total <= 0) return { ok: false, error: 'invalid_amount' };

    const pParceiro = pct('NEXUS_DEPOSIT_PCT_PARCEIRO', 0.6);
    const pSocio = pct('NEXUS_DEPOSIT_PCT_SOCIO', 0.13);
    const pIara = pct('NEXUS_DEPOSIT_PCT_IARA', 0.13);

    const slugParceiro = String(process.env.NEXUS_DEPOSIT_SLUG_PARCEIRO || 'CAIXA_CHIP').trim() || 'CAIXA_CHIP';
    const slugSocio = String(process.env.NEXUS_DEPOSIT_SLUG_SOCIO || 'LUCRO_SOCIO').trim() || 'LUCRO_SOCIO';
    const slugIara = String(process.env.NEXUS_DEPOSIT_SLUG_IARA || 'LUCRO_IARA').trim() || 'LUCRO_IARA';
    const slugRest = String(process.env.NEXUS_DEPOSIT_SLUG_REST || 'LUCRO_JORSIA').trim() || 'LUCRO_JORSIA';

    const aParceiro = round2(total * pParceiro);
    const aSocio = round2(total * pSocio);
    const aIara = round2(total * pIara);
    const aRest = round2(total - aParceiro - aSocio - aIara);

    const parts = [
        { slug: slugParceiro, amount: aParceiro, part: 'parceiro_pool' },
        { slug: slugSocio, amount: aSocio, part: 'socio' },
        { slug: slugIara, amount: aIara, part: 'iara' },
        { slug: slugRest, amount: aRest, part: 'resto' }
    ];

    const results = [];
    for (const p of parts) {
        if (p.amount <= 0) continue;
        const refId = `nexuspag_split_${id}_${p.slug}`;
        const { data, error } = await supabase.rpc('rpc_flux_wallet_credit', {
            p_slug: p.slug,
            p_amount: p.amount,
            p_ref_type: 'nexuspag_deposit_split',
            p_ref_id: refId,
            p_meta: { charge_id: id, part: p.part, gross_brl: total }
        });
        if (error) {
            console.error('[NEXUS SPLIT] rpc_flux_wallet_credit falhou:', p.slug, error.message);
            return { ok: false, error: error.message, slug: p.slug };
        }
        results.push(data);
        if (data && data.skipped) {
            return { ok: true, skipped: true, results };
        }
    }

    return { ok: true, total, results };
}

module.exports = { distributeNexusPixWalletSplit };
