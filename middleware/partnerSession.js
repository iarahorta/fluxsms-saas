/**
 * JWT Supabase + perfil parceiro ativo (partner_profiles).
 */
async function requirePartnerUser(req, res, next) {
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
            .select('id, is_partner')
            .eq('id', userData.user.id)
            .maybeSingle();

        if (profErr || !profile?.is_partner) {
            return res.status(403).json({ ok: false, error: 'forbidden', detail: 'not_a_partner' });
        }

        const { data: partnerProfile, error: ppErr } = await supabase
            .from('partner_profiles')
            .select('id, user_id, partner_code, status, margin_percent, created_at, saque_prioritario')
            .eq('user_id', userData.user.id)
            .maybeSingle();

        if (ppErr || !partnerProfile || partnerProfile.status !== 'active') {
            return res.status(403).json({ ok: false, error: 'forbidden', detail: 'partner_profile_missing_or_suspended' });
        }

        req.partnerUserId = userData.user.id;
        req.partnerProfile = partnerProfile;
        req.partnerAuthToken = token;
        return next();
    } catch (err) {
        return res.status(500).json({ ok: false, error: 'auth_check_failed', detail: err.message });
    }
}

/**
 * Apenas utilizador autenticado (para onboarding antes de ser parceiro).
 */
async function requireAuthUser(req, res, next) {
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
        req.authUserId = userData.user.id;
        req.authToken = token;
        return next();
    } catch (err) {
        return res.status(500).json({ ok: false, error: 'auth_check_failed', detail: err.message });
    }
}

module.exports = { requirePartnerUser, requireAuthUser };
