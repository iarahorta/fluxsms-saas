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

/**
 * GET /api/admin/security/sms-ingestion-events
 * Consulta operacional de auditoria SMS com resumo e alerta de anomalia.
 * Query params:
 *   - limit (default 100, max 500)
 *   - outcome (optional)
 *   - reason (optional)
 *   - minutes (default 30): janela para resumo/alerta
 */
router.get('/sms-ingestion-events', requireRootAdmin, async (req, res) => {
    const supabase = req.app.get('supabase');
    const rawLimit = Number(req.query?.limit || 100);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 500) : 100;
    const outcome = String(req.query?.outcome || '').trim().toLowerCase();
    const reason = String(req.query?.reason || '').trim().toLowerCase();
    const rawMinutes = Number(req.query?.minutes || 30);
    const minutes = Number.isFinite(rawMinutes) ? Math.min(Math.max(rawMinutes, 5), 24 * 60) : 30;
    const threshold = Number.isFinite(Number(process.env.SMS_INGESTION_ALERT_THRESHOLD))
        ? Number(process.env.SMS_INGESTION_ALERT_THRESHOLD)
        : 20;

    try {
        let query = supabase
            .from('sms_ingestion_events')
            .select('id, source, outcome, reason, activation_id, chip_porta, api_key_hash, metadata, created_at')
            .order('created_at', { ascending: false })
            .limit(limit);

        if (outcome) query = query.eq('outcome', outcome);
        if (reason) query = query.eq('reason', reason);

        const { data: events, error: listErr } = await query;
        if (listErr) {
            return res.status(500).json({ ok: false, error: 'sms_ingestion_events_failed', detail: listErr.message });
        }

        const sinceIso = new Date(Date.now() - minutes * 60 * 1000).toISOString();
        const { data: recent, error: recentErr } = await supabase
            .from('sms_ingestion_events')
            .select('outcome, reason')
            .gte('created_at', sinceIso)
            .limit(5000);
        if (recentErr) {
            return res.status(500).json({ ok: false, error: 'sms_ingestion_summary_failed', detail: recentErr.message });
        }

        const summary = {
            total: 0,
            delivered: 0,
            discarded: 0,
            error: 0,
            unauthorized: 0,
            unmatched_service: 0,
            unmatched_activation: 0,
        };
        for (const row of (recent || [])) {
            summary.total += 1;
            const o = String(row.outcome || '').toLowerCase();
            const r = String(row.reason || '').toLowerCase();
            if (o === 'delivered') summary.delivered += 1;
            if (o === 'discarded') summary.discarded += 1;
            if (o === 'error') summary.error += 1;
            if (o === 'unauthorized') summary.unauthorized += 1;
            if (r === 'unmatched_service') summary.unmatched_service += 1;
            if (r === 'unmatched_activation') summary.unmatched_activation += 1;
        }

        const discardCritical = (summary.unmatched_service + summary.unmatched_activation) >= threshold;
        const errorCritical = (summary.error + summary.unauthorized) >= Math.max(5, Math.floor(threshold / 2));
        const alert = {
            active: discardCritical || errorCritical,
            level: (discardCritical || errorCritical) ? 'warning' : 'ok',
            threshold,
            minutes,
            reasons: [
                discardCritical ? `Descartes elevados (${summary.unmatched_service + summary.unmatched_activation})` : null,
                errorCritical ? `Erros/unauthorized elevados (${summary.error + summary.unauthorized})` : null,
            ].filter(Boolean),
        };

        return res.json({
            ok: true,
            summary_window_minutes: minutes,
            summary,
            alert,
            events: events || [],
        });
    } catch (err) {
        return res.status(500).json({ ok: false, error: 'internal', detail: err.message });
    }
});

module.exports = router;
