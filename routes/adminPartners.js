const express = require('express');

const router = express.Router();

/**
 * Valida JWT do usuário e exige profiles.is_admin = true (lista sensível de parceiros).
 */
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

        req.adminUserId = userData.user.id;
        return next();
    } catch (err) {
        return res.status(500).json({ ok: false, error: 'auth_check_failed', detail: err.message });
    }
}

router.use(requireFluxAdmin);

/**
 * GET /api/admin/partners
 * Lista partner_profiles com dados básicos do perfil (somente admin).
 */
router.get('/', async (req, res) => {
    const supabase = req.app.get('supabase');
    try {
        const { data: partners, error: pErr } = await supabase
            .from('partner_profiles')
            .select('id, user_id, partner_code, status, margin_percent, notes, created_at, updated_at')
            .order('created_at', { ascending: false });

        if (pErr) {
            return res.status(500).json({ ok: false, error: 'list_failed', detail: pErr.message });
        }

        const list = partners || [];
        const ids = list.map((p) => p.user_id).filter(Boolean);
        let profileMap = {};

        if (ids.length > 0) {
            const { data: profs, error: uErr } = await supabase
                .from('profiles')
                .select('id, email, full_name, is_partner')
                .in('id', ids);

            if (!uErr && profs) {
                profileMap = Object.fromEntries(profs.map((p) => [p.id, p]));
            }
        }

        const enriched = list.map((p) => ({
            ...p,
            profile: profileMap[p.user_id] || null
        }));

        return res.json({ ok: true, partners: enriched });
    } catch (err) {
        return res.status(500).json({ ok: false, error: 'internal', detail: err.message });
    }
});

module.exports = router;
