const express = require('express');
const crypto = require('crypto');
const { requirePartnerUser } = require('../middleware/partnerSession');
const { buildFinanceSummary } = require('./partnerFinance');

const router = express.Router();

function workerDownloadUrl(req) {
    const envUrl = process.env.POLO_WORKER_DOWNLOAD_URL;
    if (envUrl && String(envUrl).trim()) {
        return String(envUrl).trim();
    }
    const proto = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.get('host');
    return `${proto}://${host}/downloads/FluxSMS-Polo-Worker-Portable.exe`;
}

router.use(requirePartnerUser);

/**
 * GET /api/partner/self/bootstrap
 * Resumo para o strip do dashboard: chaves (metadados), financeiro, link do .exe.
 */
router.get('/bootstrap', async (req, res) => {
    const supabase = req.app.get('supabase');
    const pid = req.partnerProfile.id;
    try {
        const { data: keys, error: kErr } = await supabase
            .from('partner_api_keys')
            .select('id, key_prefix, label, is_active, created_at')
            .eq('partner_id', pid)
            .eq('is_active', true)
            .order('created_at', { ascending: false });

        if (kErr) {
            return res.status(500).json({ ok: false, error: 'keys_failed', detail: kErr.message });
        }

        const finance = await buildFinanceSummary(supabase, req.partnerProfile);

        return res.json({
            ok: true,
            partner: {
                id: req.partnerProfile.id,
                partner_code: req.partnerProfile.partner_code,
                margin_percent: req.partnerProfile.margin_percent
            },
            api_keys: keys || [],
            finance,
            worker_download_url: workerDownloadUrl(req)
        });
    } catch (err) {
        return res.status(500).json({ ok: false, error: 'bootstrap_failed', detail: err.message });
    }
});

/**
 * POST /api/partner/self/api-keys
 * Gera nova Partner API Key (plaintext uma vez), como no fluxo admin.
 */
router.post('/api-keys', async (req, res) => {
    const supabase = req.app.get('supabase');
    const label = (req.body && req.body.label) ? String(req.body.label).slice(0, 120) : 'Painel parceiro';

    try {
        const plain = `flux_partner_${crypto.randomBytes(24).toString('hex')}`;
        const keyHash = crypto.createHash('sha256').update(plain).digest('hex');
        const keyPrefix = plain.slice(0, 14);

        const { data: row, error: insErr } = await supabase
            .from('partner_api_keys')
            .insert({
                partner_id: req.partnerProfile.id,
                key_hash: keyHash,
                key_prefix: keyPrefix,
                label,
                is_active: true
            })
            .select('id, key_prefix, label, created_at')
            .maybeSingle();

        if (insErr) {
            return res.status(500).json({ ok: false, error: 'insert_failed', detail: insErr.message });
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

module.exports = router;
