const express = require('express');

const router = express.Router();
const ROOT_ADMIN_EMAIL = 'iarachorta@gmail.com';

async function requireRootAdmin(req, res, next) {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
    if (!token) return res.status(401).json({ ok: false, error: 'missing_token' });

    const supabase = req.app.get('supabase');
    try {
        const { data: userData, error: userErr } = await supabase.auth.getUser(token);
        if (userErr || !userData?.user) {
            return res.status(401).json({ ok: false, error: 'invalid_token' });
        }

        const email = String(userData.user.email || '').toLowerCase();
        const { data: profile, error: profErr } = await supabase
            .from('profiles')
            .select('is_admin')
            .eq('id', userData.user.id)
            .maybeSingle();

        if (profErr || !profile?.is_admin || email !== ROOT_ADMIN_EMAIL) {
            return res.status(403).json({ ok: false, error: 'forbidden' });
        }

        req.rootAdminUser = userData.user;
        return next();
    } catch (err) {
        return res.status(500).json({ ok: false, error: 'auth_check_failed', detail: err.message });
    }
}

router.post('/reset-password', requireRootAdmin, async (req, res) => {
    const supabase = req.app.get('supabase');
    const email = String(req.body?.email || '').trim().toLowerCase();
    const newPassword = String(req.body?.new_password || '');

    if (!email || !email.includes('@')) {
        return res.status(400).json({ ok: false, error: 'invalid_email' });
    }
    if (!newPassword || newPassword.length < 8) {
        return res.status(400).json({ ok: false, error: 'invalid_password', detail: 'min_8_chars' });
    }

    try {
        const { data: usersData, error: listErr } = await supabase.auth.admin.listUsers();
        if (listErr) {
            return res.status(500).json({ ok: false, error: 'list_users_failed', detail: listErr.message });
        }

        const target = (usersData?.users || []).find((u) => String(u.email || '').toLowerCase() === email);
        if (!target) return res.status(404).json({ ok: false, error: 'user_not_found' });

        const { error: updErr } = await supabase.auth.admin.updateUserById(target.id, { password: newPassword });
        if (updErr) {
            return res.status(500).json({ ok: false, error: 'reset_failed', detail: updErr.message });
        }

        return res.json({ ok: true, user_id: target.id, email });
    } catch (err) {
        return res.status(500).json({ ok: false, error: 'internal', detail: err.message });
    }
});

module.exports = router;
