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
                .select('id, email, full_name, is_partner, balance')
                .in('id', ids);

            if (!uErr && profs) {
                profileMap = Object.fromEntries(profs.map((p) => [p.id, p]));
            }
        }

        const { data: polos } = await supabase
            .from('polos')
            .select('id, nome, partner_profile_id')
            .not('partner_profile_id', 'is', null);

        const poloIdsByPartner = {};
        const allPoloIds = [];
        (polos || []).forEach((po) => {
            if (!po.partner_profile_id) return;
            allPoloIds.push(po.id);
            if (!poloIdsByPartner[po.partner_profile_id]) poloIdsByPartner[po.partner_profile_id] = [];
            poloIdsByPartner[po.partner_profile_id].push(po.id);
        });

        const poloMeta = Object.fromEntries((polos || []).map((p) => [p.id, p]));

        let chipsByPolo = {};
        const allChipIds = [];
        if (allPoloIds.length > 0) {
            const { data: chips } = await supabase
                .from('chips')
                .select('id, polo_id, numero, porta, status, disponivel_em')
                .in('polo_id', allPoloIds);
            (chips || []).forEach((c) => {
                if (!chipsByPolo[c.polo_id]) chipsByPolo[c.polo_id] = [];
                chipsByPolo[c.polo_id].push(c);
                allChipIds.push(c.id);
            });
        }

        const revenueByChip = {};
        if (allChipIds.length > 0) {
            const { data: acts } = await supabase
                .from('activations')
                .select('chip_id, price')
                .eq('status', 'received')
                .in('chip_id', allChipIds);
            (acts || []).forEach((a) => {
                if (!a.chip_id) return;
                revenueByChip[a.chip_id] = (revenueByChip[a.chip_id] || 0) + Number(a.price || 0);
            });
        }

        const enriched = list.map((p) => {
            const poloIdList = poloIdsByPartner[p.id] || [];
            const chips = [];
            poloIdList.forEach((pid) => {
                (chipsByPolo[pid] || []).forEach((c) => {
                    chips.push({
                        ...c,
                        polo_nome: poloMeta[pid]?.nome || null,
                        revenue_total: Number((revenueByChip[c.id] || 0).toFixed(2))
                    });
                });
            });
            const revenueTotal = chips.reduce((s, c) => s + (c.revenue_total || 0), 0);
            return {
                ...p,
                profile: profileMap[p.user_id] || null,
                chips,
                chip_count: chips.length,
                revenue_total: Number(revenueTotal.toFixed(2))
            };
        });

        return res.json({ ok: true, partners: enriched });
    } catch (err) {
        return res.status(500).json({ ok: false, error: 'internal', detail: err.message });
    }
});

module.exports = router;
