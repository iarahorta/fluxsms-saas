/**
 * Distribuição contábil interna após venda concluída (SMS recebido).
 * Regra pedida: 13% LUCRO_SOCIO, 13% LUCRO_IARA, restante CAIXA_CHIP.
 * Os 60% do fornecedor ficam no modelo financeiro já existente (repasse por ativação).
 */

function round2(n) {
    return Math.round(Number(n) * 100) / 100;
}

async function distributeActivationSaleWallets(supabase, activationId) {
    const id = String(activationId || '').trim();
    if (!id) return { ok: false, error: 'missing_activation_id' };

    const { data: act, error: actErr } = await supabase
        .from('activations')
        .select('id, price')
        .eq('id', id)
        .maybeSingle();

    if (actErr) return { ok: false, error: actErr.message };
    if (!act) return { ok: false, error: 'activation_not_found' };

    const total = round2(Number(act.price || 0));
    if (!Number.isFinite(total) || total <= 0) return { ok: false, error: 'invalid_price' };

    const socio = round2(total * 0.13);
    const iara = round2(total * 0.13);
    const caixa = round2(total - socio - iara);

    const parts = [
        { slug: 'LUCRO_SOCIO', amount: socio },
        { slug: 'LUCRO_IARA', amount: iara },
        { slug: 'CAIXA_CHIP', amount: caixa }
    ];

    const results = [];
    for (const p of parts) {
        const { data, error } = await supabase.rpc('rpc_flux_wallet_credit', {
            p_slug: p.slug,
            p_amount: p.amount,
            p_ref_type: 'activation_sale',
            p_ref_id: id,
            p_meta: { activation_id: id, part: p.slug }
        });
        if (error) return { ok: false, error: error.message, slug: p.slug };
        results.push(data);
        if (data && data.skipped) {
            return { ok: true, skipped: true, results };
        }
    }

    return { ok: true, total, socio, iara, caixa, results };
}

module.exports = { distributeActivationSaleWallets };
