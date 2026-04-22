const express = require('express');
const crypto = require('crypto');
const { requireAuthUser } = require('../middleware/partnerSession');
const { ensurePartnerApiKey } = require('../lib/partnerApiKeyIssue');

const router = express.Router();

/** Repasse parceiro: 60% sobre o valor da venda (SMS recebido). */
const PARTNER_MARGIN_PERCENT = () => {
    const n = parseFloat(process.env.PARTNER_SELF_REGISTER_MARGIN_PERCENT || '60');
    return Number.isFinite(n) && n >= 0 && n <= 100 ? n : 60;
};

/** Espelha public.set_partner_code_from_email (PostgreSQL) em JS. */
function partnerCodeFromEmail(email) {
    const local = String(email || 'partner').split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, '');
    let base = local.length >= 3 ? local.slice(0, 10) : 'partner';
    const suffix = crypto.randomBytes(4).toString('hex').slice(0, 12);
    return `${base}_${suffix}`;
}

/**
 * POST /api/partner/onboarding/activate
 * Utilizador logado torna-se parceiro (idempotente). Emite Partner API Key única se ainda não existir.
 */
router.post('/activate', requireAuthUser, async (req, res) => {
    const supabase = req.app.get('supabase');
    const userId = req.authUserId;

    try {
        const { data: profile, error: pe } = await supabase
            .from('profiles')
            .select('id, email, is_partner')
            .eq('id', userId)
            .maybeSingle();

        if (pe || !profile?.email) {
            return res.status(400).json({ ok: false, error: 'profile_not_found' });
        }

        const { data: existing } = await supabase
            .from('partner_profiles')
            .select('id, partner_code, status')
            .eq('user_id', userId)
            .maybeSingle();

        const { error: upErr } = await supabase
            .from('profiles')
            .update({ is_partner: true })
            .eq('id', userId);

        if (upErr) {
            return res.status(500).json({ ok: false, error: 'profile_update_failed', detail: upErr.message });
        }

        let partnerId;
        let partnerCode;
        let apiKeyPlain = null;

        if (existing) {
            if (existing.status !== 'active') {
                await supabase
                    .from('partner_profiles')
                    .update({
                        status: 'active',
                        margin_percent: PARTNER_MARGIN_PERCENT(),
                        notes: 'Reativado via cadastro autónomo (/partner/register)'
                    })
                    .eq('id', existing.id);
            } else {
                await supabase
                    .from('partner_profiles')
                    .update({ margin_percent: PARTNER_MARGIN_PERCENT() })
                    .eq('id', existing.id);
            }
            partnerId = existing.id;
            partnerCode = existing.partner_code;

            const ensured = await ensurePartnerApiKey(supabase, partnerId, 'Identidade parceiro');
            apiKeyPlain = ensured.plain;
            return res.json({
                ok: true,
                already: !!profile.is_partner,
                partner_id: partnerId,
                partner_code: partnerCode,
                margin_percent: PARTNER_MARGIN_PERCENT(),
                api_key: apiKeyPlain
            });
        }

        let newCode = partnerCodeFromEmail(profile.email);
        for (let attempt = 0; attempt < 8; attempt++) {
            const { data: conflict } = await supabase
                .from('partner_profiles')
                .select('id')
                .eq('partner_code', newCode)
                .maybeSingle();
            if (!conflict) break;
            newCode = partnerCodeFromEmail(profile.email);
        }

        const { data: row, error: insErr } = await supabase
            .from('partner_profiles')
            .insert({
                user_id: userId,
                partner_code: newCode,
                margin_percent: PARTNER_MARGIN_PERCENT(),
                status: 'active',
                notes: 'Cadastro autónomo (/partner/register)'
            })
            .select('id, partner_code, margin_percent, status')
            .maybeSingle();

        if (insErr) {
            return res.status(500).json({ ok: false, error: 'partner_insert_failed', detail: insErr.message });
        }

        partnerId = row.id;
        partnerCode = row.partner_code;
        const ensured = await ensurePartnerApiKey(supabase, partnerId, 'Identidade parceiro');
        apiKeyPlain = ensured.plain;

        return res.status(201).json({
            ok: true,
            partner_id: partnerId,
            partner_code: partnerCode,
            margin_percent: row.margin_percent,
            api_key: apiKeyPlain
        });
    } catch (err) {
        return res.status(500).json({ ok: false, error: 'internal', detail: err.message });
    }
});

module.exports = router;
