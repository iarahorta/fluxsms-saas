const express = require('express');
const { rotatePartnerApiKey } = require('../lib/partnerApiKeyIssue');
const { decryptPartnerApiKeySecret } = require('../lib/partnerKeyVault');

const router = express.Router();

function normalizeCustomCommission(value) {
    const n = Number(value);
    if (Number.isInteger(n) && n >= 1 && n <= 100) return n;
    return null;
}

function resolveCommissionForDisplay(row) {
    const custom = normalizeCustomCommission(row?.custom_commission);
    if (custom != null) return custom;
    const legacy = normalizeCustomCommission(row?.margin_percent);
    if (legacy != null) return legacy;
    return null;
}

/**
 * GET /api/admin/partners/:partnerProfileId/commission
 * Retorna comissão efetiva do parceiro (fallback para margin_percent).
 */
router.get('/:partnerProfileId/commission', async (req, res) => {
    const supabase = req.app.get('supabase');
    const { partnerProfileId } = req.params;
    try {
        let data = null;
        let error = null;
        ({ data, error } = await supabase
            .from('partner_profiles')
            .select('id, partner_code, margin_percent, custom_commission')
            .eq('id', partnerProfileId)
            .maybeSingle());
        if (error && String(error.message || '').includes('custom_commission')) {
            const retry = await supabase
                .from('partner_profiles')
                .select('id, partner_code, margin_percent')
                .eq('id', partnerProfileId)
                .maybeSingle();
            data = retry.data ? { ...retry.data, custom_commission: null } : null;
            error = retry.error;
        }
        if (error) return res.status(500).json({ ok: false, error: 'read_failed', detail: error.message });
        if (!data) return res.status(404).json({ ok: false, error: 'partner_not_found' });
        const commission = resolveCommissionForDisplay(data) || 60;
        return res.json({ ok: true, partner_id: data.id, partner_code: data.partner_code, commission });
    } catch (err) {
        return res.status(500).json({ ok: false, error: 'internal', detail: err.message });
    }
});

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
 * POST /api/admin/partners/:partnerProfileId/commission
 * body: { commission: integer 1..100 }
 * Endpoint dedicado para persistir comissão mesmo sem coluna custom_commission.
 */
router.post('/:partnerProfileId/commission', async (req, res) => {
    const supabase = req.app.get('supabase');
    const { partnerProfileId } = req.params;
    const raw = req.body && req.body.commission;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 100) {
        return res.status(400).json({ ok: false, error: 'invalid_body', detail: 'commission_must_be_integer_1_100' });
    }
    try {
        // 1) Sempre salva em margin_percent (coluna legada presente).
        let { data, error } = await supabase
            .from('partner_profiles')
            .update({ margin_percent: n })
            .eq('id', partnerProfileId)
            .select('id, partner_code, margin_percent, saque_prioritario')
            .maybeSingle();

        if (error) {
            return res.status(500).json({ ok: false, error: 'update_failed', detail: error.message });
        }
        if (!data) {
            return res.status(404).json({ ok: false, error: 'partner_not_found' });
        }

        // 2) Tenta espelhar em custom_commission quando existir.
        const customTry = await supabase
            .from('partner_profiles')
            .update({ custom_commission: n })
            .eq('id', partnerProfileId)
            .select('id, partner_code, margin_percent, custom_commission, saque_prioritario')
            .maybeSingle();

        if (!customTry.error && customTry.data) {
            data = customTry.data;
        }

        // 3) Confirma leitura final no banco (fonte da verdade).
        let finalRow = null;
        let finalErr = null;
        ({ data: finalRow, error: finalErr } = await supabase
            .from('partner_profiles')
            .select('id, partner_code, margin_percent, custom_commission, saque_prioritario')
            .eq('id', partnerProfileId)
            .maybeSingle());
        if (finalErr && String(finalErr.message || '').includes('custom_commission')) {
            const retryRead = await supabase
                .from('partner_profiles')
                .select('id, partner_code, margin_percent, saque_prioritario')
                .eq('id', partnerProfileId)
                .maybeSingle();
            finalRow = retryRead.data ? { ...retryRead.data, custom_commission: null } : null;
            finalErr = retryRead.error;
        }
        if (finalErr || !finalRow) {
            return res.status(500).json({ ok: false, error: 'read_after_write_failed', detail: finalErr?.message || 'partner_not_found_after_write' });
        }
        data = finalRow;
        const persisted = resolveCommissionForDisplay(data);
        if (!Number.isInteger(persisted) || persisted !== n) {
            return res.status(409).json({
                ok: false,
                error: 'commission_not_persisted',
                detail: 'commission_mismatch_after_write',
                expected: n,
                got: persisted
            });
        }

        return res.json({
            ok: true,
            commission: persisted,
            partner: {
                ...data,
                custom_commission: resolveCommissionForDisplay(data)
            }
        });
    } catch (err) {
        return res.status(500).json({ ok: false, error: 'internal', detail: err.message });
    }
});

/**
 * PATCH /api/admin/partners/:partnerProfileId/withdrawals/:withdrawalId
 * body: { status: 'approved' | 'paid' | 'rejected' | 'pending' }
 * Na primeira aprovação/pagamento, regista fee_applied_at (taxa administrativa R$ 5).
 */
router.patch('/:partnerProfileId/withdrawals/:withdrawalId', async (req, res) => {
    const supabase = req.app.get('supabase');
    const { partnerProfileId, withdrawalId } = req.params;
    const status = req.body && req.body.status ? String(req.body.status).toLowerCase() : '';
    const allowed = ['approved', 'paid', 'rejected', 'pending'];
    if (!allowed.includes(status)) {
        return res.status(400).json({ ok: false, error: 'invalid_status' });
    }
    try {
        const { data: row, error: fErr } = await supabase
            .from('partner_withdrawal_requests')
            .select('id, status, fee_applied_at')
            .eq('id', withdrawalId)
            .eq('partner_id', partnerProfileId)
            .maybeSingle();

        if (fErr || !row) {
            return res.status(404).json({ ok: false, error: 'withdrawal_not_found' });
        }

        const updates = { status, updated_at: new Date().toISOString() };
        if ((status === 'approved' || status === 'paid') && row.status === 'pending' && !row.fee_applied_at) {
            updates.fee_applied_at = new Date().toISOString();
        }

        const { data: out, error: uErr } = await supabase
            .from('partner_withdrawal_requests')
            .update(updates)
            .eq('id', withdrawalId)
            .select('id, status, amount, fee_brl, net_amount, fee_applied_at')
            .maybeSingle();

        if (uErr) {
            return res.status(500).json({ ok: false, error: 'update_failed', detail: uErr.message });
        }
        return res.json({ ok: true, withdrawal: out });
    } catch (err) {
        return res.status(500).json({ ok: false, error: 'internal', detail: err.message });
    }
});

/**
 * PATCH /api/admin/partners/:partnerProfileId
 * body: { saque_prioritario?: boolean, custom_commission?: integer }.
 */
router.patch('/:partnerProfileId', async (req, res) => {
    const supabase = req.app.get('supabase');
    const { partnerProfileId } = req.params;
    const sp = req.body && req.body.saque_prioritario;
    const ccRaw = req.body && req.body.custom_commission;
    const patch = {};
    if (typeof sp === 'boolean') patch.saque_prioritario = sp;
        if (ccRaw !== undefined && ccRaw !== null && ccRaw !== '') {
        const n = Number(ccRaw);
        if (!Number.isInteger(n) || n < 1 || n > 100) {
            return res.status(400).json({ ok: false, error: 'invalid_body', detail: 'custom_commission_must_be_integer_1_100' });
        }
        patch.custom_commission = n;
            patch.margin_percent = n;
    } else if (ccRaw === null || ccRaw === '') {
        patch.custom_commission = null;
    }
    if (!Object.keys(patch).length) {
        return res.status(400).json({ ok: false, error: 'invalid_body', detail: 'provide_saque_prioritario_or_custom_commission' });
    }
    try {
        let updatePatch = { ...patch };
        let { data, error } = await supabase
            .from('partner_profiles')
            .update(updatePatch)
            .eq('id', partnerProfileId)
            .select('id, partner_code, saque_prioritario, margin_percent, custom_commission')
            .maybeSingle();

        // Compatibilidade: ambiente sem coluna custom_commission (migração pendente).
        if (error && String(error.message || '').includes('custom_commission')) {
            delete updatePatch.custom_commission;
            if (!Object.keys(updatePatch).length) {
                return res.status(400).json({ ok: false, error: 'migration_required', detail: 'custom_commission_column_missing' });
            }
            if (updatePatch.custom_commission != null) {
                updatePatch.margin_percent = updatePatch.custom_commission;
            }
            delete updatePatch.custom_commission;
            const retry = await supabase
                .from('partner_profiles')
                .update(updatePatch)
                .eq('id', partnerProfileId)
                .select('id, partner_code, saque_prioritario, margin_percent')
                .maybeSingle();
            data = retry.data ? { ...retry.data, custom_commission: retry.data.margin_percent ?? null } : null;
            error = retry.error;
        }

        if (error) {
            return res.status(500).json({ ok: false, error: 'update_failed', detail: error.message });
        }
        if (!data) {
            return res.status(404).json({ ok: false, error: 'partner_not_found' });
        }
        return res.json({
            ok: true,
            partner: {
                ...data,
                custom_commission: resolveCommissionForDisplay(data)
            }
        });
    } catch (err) {
        return res.status(500).json({ ok: false, error: 'internal', detail: err.message });
    }
});

/**
 * GET /api/admin/partners/:partnerProfileId/api-keys
 * Lista metadados das chaves (sem revelar hash).
 */
router.get('/:partnerProfileId/api-keys', async (req, res) => {
    const supabase = req.app.get('supabase');
    const { partnerProfileId } = req.params;
    try {
        const { data: partner, error: pErr } = await supabase
            .from('partner_profiles')
            .select('id')
            .eq('id', partnerProfileId)
            .maybeSingle();
        if (pErr || !partner) {
            return res.status(404).json({ ok: false, error: 'partner_not_found' });
        }

        const { data: keys, error: kErr } = await supabase
            .from('partner_api_keys')
            .select('id, key_prefix, label, is_active, last_used_at, expires_at, created_at, secret_ciphertext, secret_iv, secret_tag')
            .eq('partner_id', partnerProfileId)
            .order('created_at', { ascending: false });

        if (kErr) {
            return res.status(500).json({ ok: false, error: 'keys_list_failed', detail: kErr.message });
        }
        const out = (keys || []).map((k) => ({
            id: k.id,
            key_prefix: k.key_prefix,
            label: k.label,
            is_active: k.is_active,
            last_used_at: k.last_used_at,
            expires_at: k.expires_at,
            created_at: k.created_at,
            api_key_plain: decryptPartnerApiKeySecret(k) || null
        }));
        return res.json({ ok: true, keys: out });
    } catch (err) {
        return res.status(500).json({ ok: false, error: 'internal', detail: err.message });
    }
});

/**
 * POST /api/admin/partners/:partnerProfileId/api-keys
 * Gera nova Partner API Key (plaintext devolvida uma única vez no JSON).
 */
router.post('/:partnerProfileId/api-keys', async (req, res) => {
    const supabase = req.app.get('supabase');
    const { partnerProfileId } = req.params;
    const label = (req.body && req.body.label) ? String(req.body.label).slice(0, 120) : 'Admin Hub';

    try {
        const { data: partner, error: pErr } = await supabase
            .from('partner_profiles')
            .select('id, status')
            .eq('id', partnerProfileId)
            .maybeSingle();
        if (pErr || !partner) {
            return res.status(404).json({ ok: false, error: 'partner_not_found' });
        }
        if (partner.status !== 'active') {
            return res.status(400).json({ ok: false, error: 'partner_not_active' });
        }

        let plain;
        let row;
        try {
            const out = await rotatePartnerApiKey(supabase, partnerProfileId, label);
            plain = out.plain;
            row = out.row;
        } catch (e) {
            return res.status(500).json({ ok: false, error: 'key_rotate_failed', detail: e.message });
        }

        return res.status(201).json({
            ok: true,
            api_key: plain,
            key: row
        });
    } catch (err) {
        return res.status(500).json({ ok: false, error: 'internal', detail: err.message });
    }
});

/**
 * POST /api/admin/partners/:partnerProfileId/chips/force-offline
 * Botão admin: força OFFLINE para todos os chips da API Key do parceiro.
 */
router.post('/:partnerProfileId/chips/force-offline', async (req, res) => {
    const supabase = req.app.get('supabase');
    const { partnerProfileId } = req.params;
    try {
        const { data: polos, error: pErr } = await supabase
            .from('polos')
            .select('id')
            .eq('partner_profile_id', partnerProfileId);
        if (pErr) {
            return res.status(500).json({ ok: false, error: 'polos_failed', detail: pErr.message });
        }
        const poloIds = (polos || []).map((p) => p.id).filter(Boolean);
        if (!poloIds.length) {
            return res.json({ ok: true, polos: 0, chips_offline: 0 });
        }

        const { data: chips, error: cErr } = await supabase
            .from('chips')
            .update({ status: 'offline' })
            .in('polo_id', poloIds)
            .select('id');
        if (cErr) {
            return res.status(500).json({ ok: false, error: 'chips_update_failed', detail: cErr.message });
        }

        await supabase
            .from('polos')
            .update({ status: 'OFFLINE' })
            .in('id', poloIds);

        return res.json({
            ok: true,
            polos: poloIds.length,
            chips_offline: (chips || []).length
        });
    } catch (err) {
        return res.status(500).json({ ok: false, error: 'force_offline_failed', detail: err.message });
    }
});

/**
 * DELETE /api/admin/partners/:partnerProfileId
 * Limpeza completa para recomeçar base de parceiros.
 */
router.delete('/:partnerProfileId', async (req, res) => {
    const supabase = req.app.get('supabase');
    const { partnerProfileId } = req.params;
    try {
        const { data: partner, error: pErr } = await supabase
            .from('partner_profiles')
            .select('id, partner_code')
            .eq('id', partnerProfileId)
            .maybeSingle();
        if (pErr || !partner) {
            return res.status(404).json({ ok: false, error: 'partner_not_found' });
        }

        const { data: polos } = await supabase
            .from('polos')
            .select('id')
            .eq('partner_profile_id', partnerProfileId);
        const poloIds = (polos || []).map((p) => p.id).filter(Boolean);

        if (poloIds.length) {
            const delChips = await supabase
                .from('chips')
                .delete()
                .in('polo_id', poloIds);
            if (delChips.error) {
                return res.status(500).json({ ok: false, error: 'chips_delete_failed', detail: delChips.error.message });
            }
            const delPolos = await supabase
                .from('polos')
                .delete()
                .in('id', poloIds);
            if (delPolos.error) {
                return res.status(500).json({ ok: false, error: 'polos_delete_failed', detail: delPolos.error.message });
            }
        }

        const optionalDeletes = [
            supabase.from('partner_api_keys').delete().eq('partner_id', partnerProfileId),
            supabase.from('partner_withdrawal_requests').delete().eq('partner_id', partnerProfileId),
            supabase.from('partner_service_toggles').delete().eq('partner_id', partnerProfileId)
        ];
        for (const op of optionalDeletes) {
            const r = await op;
            if (r.error && !String(r.error.message || '').toLowerCase().includes('does not exist')) {
                return res.status(500).json({ ok: false, error: 'related_delete_failed', detail: r.error.message });
            }
        }

        const delPartner = await supabase
            .from('partner_profiles')
            .delete()
            .eq('id', partnerProfileId);
        if (delPartner.error) {
            return res.status(500).json({ ok: false, error: 'partner_delete_failed', detail: delPartner.error.message });
        }

        return res.json({ ok: true, partner_code: partner.partner_code, polos_removed: poloIds.length });
    } catch (err) {
        return res.status(500).json({ ok: false, error: 'internal', detail: err.message });
    }
});

/**
 * GET /api/admin/partners
 * Lista partner_profiles com dados básicos do perfil (somente admin).
 */
router.get('/', async (req, res) => {
    const supabase = req.app.get('supabase');
    try {
        let partners = null;
        let pErr = null;
        ({ data: partners, error: pErr } = await supabase
            .from('partner_profiles')
            .select('id, user_id, partner_code, status, margin_percent, notes, created_at, updated_at, saque_prioritario, custom_commission')
            .order('created_at', { ascending: false }));

        // Compatibilidade: ambiente sem coluna custom_commission (migração pendente).
        if (pErr && String(pErr.message || '').includes('custom_commission')) {
            const retry = await supabase
                .from('partner_profiles')
                .select('id, user_id, partner_code, status, margin_percent, notes, created_at, updated_at, saque_prioritario')
                .order('created_at', { ascending: false });
            partners = (retry.data || []).map((p) => ({ ...p, custom_commission: p.margin_percent ?? null }));
            pErr = retry.error;
        }

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
                .select('id, polo_id, numero, porta, status, disponivel_em, last_ping, registered_by_api_key_id')
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
                custom_commission: resolveCommissionForDisplay(p),
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
