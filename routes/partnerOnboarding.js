const express = require('express');
const crypto = require('crypto');
const { requireAuthUser } = require('../middleware/partnerSession');

const router = express.Router();

const DEFAULT_MARGIN = () => {
    const n = parseFloat(process.env.PARTNER_SELF_REGISTER_MARGIN_PERCENT || '10');
    return Number.isFinite(n) && n >= 0 && n <= 100 ? n : 10;
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
 * Utilizador logado torna-se parceiro (idempotente). Service role grava perfil.
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

        if (existing) {
            if (existing.status !== 'active') {
                await supabase
                    .from('partner_profiles')
                    .update({
                        status: 'active',
                        notes: 'Reativado via cadastro autónomo (/partner/register)'
                    })
                    .eq('id', existing.id);
            }
            return res.json({
                ok: true,
                already: !!profile.is_partner,
                partner_id: existing.id,
                partner_code: existing.partner_code
            });
        }

        let partnerCode = partnerCodeFromEmail(profile.email);
        for (let attempt = 0; attempt < 8; attempt++) {
            const { data: conflict } = await supabase
                .from('partner_profiles')
                .select('id')
                .eq('partner_code', partnerCode)
                .maybeSingle();
            if (!conflict) break;
            partnerCode = partnerCodeFromEmail(profile.email);
        }

        const { data: row, error: insErr } = await supabase
            .from('partner_profiles')
            .insert({
                user_id: userId,
                partner_code: partnerCode,
                margin_percent: DEFAULT_MARGIN(),
                status: 'active',
                notes: 'Cadastro autónomo (/partner/register)'
            })
            .select('id, partner_code, margin_percent, status')
            .maybeSingle();

        if (insErr) {
            return res.status(500).json({ ok: false, error: 'partner_insert_failed', detail: insErr.message });
        }

        return res.status(201).json({
            ok: true,
            partner_id: row.id,
            partner_code: row.partner_code,
            margin_percent: row.margin_percent
        });
    } catch (err) {
        return res.status(500).json({ ok: false, error: 'internal', detail: err.message });
    }
});

module.exports = router;
