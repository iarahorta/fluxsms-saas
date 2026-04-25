const express = require('express');
const { buildFinanceSummary } = require('./partnerFinance');

const router = express.Router();

function isUuid(v) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(v || '').trim());
}

async function requireFluxAdmin(req, res, next) {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
    if (!token) {
        return res.status(401).json({ ok: false, error: 'missing_token' });
    }

    const supabase = req.app.get('supabase');
    try {
        const { data: userData, error: userErr } = await supabase.auth.getUser(token);
        if (userErr || !userData?.user) {
            return res.status(401).json({ ok: false, error: 'invalid_token' });
        }

        const { data: profile, error: profErr } = await supabase
            .from('profiles')
            .select('is_admin')
            .eq('id', userData.user.id)
            .maybeSingle();

        if (profErr || !profile?.is_admin) {
            return res.status(403).json({ ok: false, error: 'forbidden' });
        }

        req.fluxAdminUserId = userData.user.id;
        return next();
    } catch (e) {
        return res.status(500).json({ ok: false, error: 'admin_auth_failed', detail: e.message });
    }
}

/**
 * GET /api/admin/financas-flux
 * Visão consolidada: saldos das wallets virtuais + (opcional) detalhe de parceiro.
 * Query: ?partner=codigo_ou_email_ou_nome (busca simples)
 */
router.get('/', requireFluxAdmin, async (req, res) => {
    const supabase = req.app.get('supabase');
    const partnerQ = String(req.query.partner || '').trim();

    try {
        const { data: wallets, error: wErr } = await supabase
            .from('virtual_wallets')
            .select('slug, display_name, balance, updated_at')
            .order('slug', { ascending: true });

        if (wErr) {
            return res.status(500).json({ ok: false, error: 'wallets_failed', detail: wErr.message });
        }

        let partnerDetail = null;
        if (partnerQ) {
            let query = supabase
                .from('partner_profiles')
                .select('id, partner_code, user_id, status, created_at, margin_percent, custom_commission, saque_prioritario, notes')
                .limit(15);

            if (isUuid(partnerQ)) {
                query = query.eq('id', partnerQ);
            } else {
                const like = `%${partnerQ.replace(/%/g, '')}%`;
                query = query.ilike('partner_code', like);
            }

            const { data: partners, error: pErr } = await query;

            if (pErr) {
                return res.status(500).json({ ok: false, error: 'partner_search_failed', detail: pErr.message });
            }

            const enriched = [];
            for (const p of partners || []) {
                let email = null;
                let full_name = null;
                if (p.user_id) {
                    const { data: prof } = await supabase
                        .from('profiles')
                        .select('email, full_name')
                        .eq('id', p.user_id)
                        .maybeSingle();
                    email = prof?.email || null;
                    full_name = prof?.full_name || null;
                }
                enriched.push({ ...p, email, full_name });
            }

            if (enriched.length === 1) {
                const p = enriched[0];
                const summary = await buildFinanceSummary(supabase, p);
                partnerDetail = { profile: p, finance: summary };
            } else {
                partnerDetail = { matches: enriched };
            }
        }

        const { data: recentLedger, error: lErr } = await supabase
            .from('virtual_wallet_ledger')
            .select('id, amount, ref_type, ref_id, created_at, wallet_id')
            .order('created_at', { ascending: false })
            .limit(40);

        if (lErr) {
            return res.status(500).json({ ok: false, error: 'ledger_failed', detail: lErr.message });
        }

        return res.json({
            ok: true,
            title: 'Finanças Flux',
            virtual_wallets: wallets || [],
            recent_ledger: recentLedger || [],
            partner: partnerDetail
        });
    } catch (err) {
        return res.status(500).json({ ok: false, error: 'financas_flux_failed', detail: err.message });
    }
});

module.exports = router;
