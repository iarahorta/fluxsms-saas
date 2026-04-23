const express = require('express');
const { requirePartnerUser } = require('../middleware/partnerSession');
const { buildFinanceSummary } = require('./partnerFinance');
const { decryptPartnerApiKeySecret } = require('../lib/partnerKeyVault');

const router = express.Router();

function workerDownloadUrl(req) {
    const rawProto = (req.headers['x-forwarded-proto'] || req.protocol || 'https')
        .toString()
        .split(',')[0]
        .trim();
    const host = req.get('host') || 'fluxsms.com.br';
    const sameOrigin = `${rawProto}://${host}/download/FluxSMS.0.4.4.exe`;

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

/**
 * GET /api/partner/self/bootstrap
 */
router.get('/bootstrap', async (req, res) => {
    const supabase = req.app.get('supabase');
    const pid = req.partnerProfile.id;
    try {
        const { data: keyRow, error: kErr } = await supabase
            .from('partner_api_keys')
            .select('id, key_prefix, label, is_active, created_at, secret_ciphertext, secret_iv, secret_tag')
            .eq('partner_id', pid)
            .eq('is_active', true)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();

        if (kErr) {
            return res.status(500).json({ ok: false, error: 'keys_failed', detail: kErr.message });
        }

        const apiKeyPlain = keyRow ? decryptPartnerApiKeySecret(keyRow) : null;

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
            api_key_prefix: keyRow?.key_prefix || null,
            api_key_plain: apiKeyPlain,
            api_key_status: apiKeyPlain ? 'ok' : (keyRow ? 'decrypt_failed' : 'no_active_key'),
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

module.exports = router;
