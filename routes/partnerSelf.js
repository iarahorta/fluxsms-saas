const express = require('express');
const { requirePartnerUser } = require('../middleware/partnerSession');
const { buildFinanceSummary } = require('./partnerFinance');
const { decryptPartnerApiKeySecret } = require('../lib/partnerKeyVault');
const { generatePlainPartnerKey } = require('../lib/partnerApiKeyIssue');
const { encryptPartnerApiKeyPlain } = require('../lib/partnerKeyVault');

const router = express.Router();

function workerDownloadUrl(req) {
    const rawProto = (req.headers['x-forwarded-proto'] || req.protocol || 'https')
        .toString()
        .split(',')[0]
        .trim();
    const host = req.get('host') || 'fluxsms.com.br';
    const sameOrigin = `${rawProto}://${host}/download/FluxSMS.0.5.3.exe`;

    const envUrl = (process.env.POLO_WORKER_DOWNLOAD_URL || '').trim();
    if (!envUrl) return sameOrigin;

    // Produção: URL canónica (Railway) — use o mesmo path em fluxsms.com.br
    if (/fluxsms\.com\.br\/download\/FluxSMS(\.|_)\d+\.\d+\.\d+\.exe/i.test(envUrl)) {
        return envUrl;
    }

    // Legado: Portable, pasta /downloads/ antiga, ou qualquer .exe nessa pasta
    if (
        /FluxSMS-Polo-Worker-Portable\.exe/i.test(envUrl) ||
        /\/downloads\/[^/]+\.exe(\?|$)/i.test(envUrl) ||
        /\/download\/FluxSMS-Polo-Worker-Portable\.exe/i.test(envUrl)
    ) {
        return sameOrigin;
    }

    return envUrl;
}

router.use(requirePartnerUser);

const PARTNER_MAX_ACTIVE_KEYS = 3;

/**
 * GET /api/partner/self/bootstrap
 */
router.get('/bootstrap', async (req, res) => {
    const supabase = req.app.get('supabase');
    const pid = req.partnerProfile.id;
    try {
        const { data: keyRows, error: kErr } = await supabase
            .from('partner_api_keys')
            .select('id, key_prefix, label, is_active, created_at, secret_ciphertext, secret_iv, secret_tag')
            .eq('partner_id', pid)
            .eq('is_active', true)
            .order('created_at', { ascending: false })
            .limit(20);

        if (kErr) {
            return res.status(500).json({ ok: false, error: 'keys_failed', detail: kErr.message });
        }

        const rows = Array.isArray(keyRows) ? keyRows : [];
        const keyList = rows
            .map((row) => ({
                id: row.id,
                key_prefix: row.key_prefix,
                label: row.label,
                is_active: row.is_active,
                created_at: row.created_at,
                api_key_plain: decryptPartnerApiKeySecret(row) || null
            }))
            .filter((k) => !!k.api_key_plain);
        const apiKeyPlain = keyList.length ? keyList[0].api_key_plain : null;

        let userEmail = null;
        let userName = null;
        try {
            const { data: uData } = await supabase.auth.getUser(req.partnerAuthToken);
            if (uData?.user) {
                userEmail = uData.user.email || null;
                const m = uData.user.user_metadata || {};
                userName = m.full_name || m.name || m.display_name || null;
            }
        } catch {
            /* continua com null */
        }

        const finance = await buildFinanceSummary(supabase, req.partnerProfile);

        const repassePct = finance && finance.rules && finance.rules.repasse_percent != null
            ? Number(finance.rules.repasse_percent)
            : 60;

        return res.json({
            ok: true,
            user_email: userEmail,
            user_name: userName,
            partner: {
                id: req.partnerProfile.id,
                partner_code: req.partnerProfile.partner_code,
                repasse_percent: repassePct
            },
            api_key_prefix: rows[0]?.key_prefix || null,
            api_key_plain: apiKeyPlain,
            api_key_status: apiKeyPlain ? 'ok' : (rows.length ? 'decrypt_failed' : 'no_active_key'),
            api_keys_active_count: keyList.length,
            api_keys_active: keyList,
            finance,
            worker_download_url: workerDownloadUrl(req)
        });
    } catch (err) {
        return res.status(500).json({ ok: false, error: 'bootstrap_failed', detail: err.message });
    }
});

/**
 * GET /api/partner/self/chips — chips dos polos vinculados ao parceiro.
 */
router.get('/chips', async (req, res) => {
    const supabase = req.app.get('supabase');
    const pid = req.partnerProfile.id;
    try {
        const { data: polos, error: pErr } = await supabase
            .from('polos')
            .select('id, nome, status, ultima_comunicacao, chave_acesso')
            .eq('partner_profile_id', pid);

        if (pErr) {
            return res.status(500).json({ ok: false, error: 'polos_failed', detail: pErr.message });
        }

        const poloIds = (polos || []).map((p) => p.id);
        const poloById = Object.fromEntries((polos || []).map((p) => [p.id, p]));

        if (poloIds.length === 0) {
            return res.json({ ok: true, chips: [], polos: polos || [] });
        }

        const { data: chips, error: cErr } = await supabase
            .from('chips')
            .select('id, polo_id, porta, numero, status, disponivel_em, operadora')
            .in('polo_id', poloIds)
            .order('porta');

        if (cErr) {
            return res.status(500).json({ ok: false, error: 'chips_failed', detail: cErr.message });
        }

        const enriched = (chips || []).map((c) => ({
            ...c,
            polo_nome: poloById[c.polo_id]?.nome || null,
            polo_status: poloById[c.polo_id]?.status || null,
            polo_ultima: poloById[c.polo_id]?.ultima_comunicacao || null
        }));

        return res.json({ ok: true, chips: enriched, polos: polos || [] });
    } catch (err) {
        return res.status(500).json({ ok: false, error: 'chips_route_failed', detail: err.message });
    }
});

const DEFAULT_PARTNER_SERVICES = [
    { service: 'whatsapp', enabled: true },
    { service: 'telegram', enabled: true },
    { service: 'google', enabled: true },
    { service: 'instagram', enabled: true }
];

router.get('/service-toggles', async (req, res) => {
    const supabase = req.app.get('supabase');
    const pid = req.partnerProfile.id;
    try {
        let { data, error } = await supabase
            .from('partner_service_costs')
            .select('service, enabled')
            .eq('partner_id', pid);
        if (error && String(error.message || '').toLowerCase().includes('enabled')) {
            const legacy = await supabase
                .from('partner_service_costs')
                .select('service')
                .eq('partner_id', pid);
            data = legacy.data || [];
            error = legacy.error;
        }
        if (error) {
            return res.status(500).json({ ok: false, error: 'service_toggles_failed', detail: error.message });
        }
        const rows = data || [];
        const merged = DEFAULT_PARTNER_SERVICES.map((svc) => {
            const hit = rows.find((r) => String(r.service || '').toLowerCase() === svc.service);
            if (!hit) return svc;
            return {
                service: svc.service,
                enabled: hit.enabled !== false
            };
        });
        return res.json({ ok: true, services: merged });
    } catch (err) {
        return res.status(500).json({ ok: false, error: 'service_toggles_route_failed', detail: err.message });
    }
});

/**
 * POST /api/partner/self/api-keys
 * Cria nova API key para novo PC sem desativar as anteriores.
 * Limite operacional: 3 chaves ativas por parceiro.
 */
router.post('/api-keys', async (req, res) => {
    const supabase = req.app.get('supabase');
    const pid = req.partnerProfile.id;
    const label = (req.body && req.body.label) ? String(req.body.label).slice(0, 120) : 'Novo PC';
    try {
        const { data: activeRows, error: countErr } = await supabase
            .from('partner_api_keys')
            .select('id')
            .eq('partner_id', pid)
            .eq('is_active', true);
        if (countErr) {
            return res.status(500).json({ ok: false, error: 'keys_count_failed', detail: countErr.message });
        }
        const activeCount = Array.isArray(activeRows) ? activeRows.length : 0;
        if (activeCount >= PARTNER_MAX_ACTIVE_KEYS) {
            return res.status(400).json({
                ok: false,
                error: 'active_keys_limit_reached',
                detail: 'Limite de 3 chaves ativas. Para mais, contacte o suporte FluxSMS.'
            });
        }

        const plain = generatePlainPartnerKey();
        const keyHash = require('crypto').createHash('sha256').update(plain).digest('hex');
        const keyPrefix = plain.slice(0, 14);
        const vault = encryptPartnerApiKeyPlain(plain);
        const payload = {
            partner_id: pid,
            key_hash: keyHash,
            key_prefix: keyPrefix,
            label: label || `PC ${activeCount + 1}`,
            is_active: true,
            bound_hwid: null
        };
        if (vault) {
            payload.secret_ciphertext = vault.ciphertext;
            payload.secret_iv = vault.iv;
            payload.secret_tag = vault.tag;
        }
        const { data: row, error: insErr } = await supabase
            .from('partner_api_keys')
            .insert(payload)
            .select('id, key_prefix, label, is_active, created_at')
            .maybeSingle();
        if (insErr) {
            return res.status(500).json({ ok: false, error: 'key_create_failed', detail: insErr.message });
        }
        return res.status(201).json({
            ok: true,
            api_key: plain,
            key: row,
            active_keys_count: activeCount + 1,
            active_keys_limit: PARTNER_MAX_ACTIVE_KEYS
        });
    } catch (err) {
        return res.status(500).json({ ok: false, error: 'key_create_route_failed', detail: err.message });
    }
});

router.put('/service-toggles', async (req, res) => {
    const supabase = req.app.get('supabase');
    const pid = req.partnerProfile.id;
    const input = Array.isArray(req.body?.services) ? req.body.services : [];
    const normalized = input
        .map((r) => ({
            service: String(r?.service || '').trim().toLowerCase(),
            enabled: r?.enabled !== false
        }))
        .filter((r) => !!r.service);
    if (!normalized.length) {
        return res.status(400).json({ ok: false, error: 'services_required' });
    }
    try {
        const payload = normalized.map((r) => ({
            partner_id: pid,
            service: r.service,
            cost_price: 0,
            enabled: r.enabled
        }));
        let { error } = await supabase
            .from('partner_service_costs')
            .upsert(payload, { onConflict: 'partner_id,service' });
        if (error && String(error.message || '').toLowerCase().includes('enabled')) {
            const legacyPayload = normalized.map((r) => ({
                partner_id: pid,
                service: r.service,
                cost_price: 0
            }));
            const legacy = await supabase
                .from('partner_service_costs')
                .upsert(legacyPayload, { onConflict: 'partner_id,service' });
            error = legacy.error;
        }
        if (error) {
            return res.status(500).json({ ok: false, error: 'service_toggles_update_failed', detail: error.message });
        }
        return res.json({ ok: true, updated: payload.length });
    } catch (err) {
        return res.status(500).json({ ok: false, error: 'service_toggles_update_route_failed', detail: err.message });
    }
});

module.exports = router;
