const crypto = require('crypto');

/**
 * Valida token de webhook da Nexus/NexusPag (query ?token=).
 * O URL enviado à Nexus na criação do PIX inclui ?token=... (ver routes/webhook.js).
 * Configure NEXUSPAG_WEBHOOK_TOKEN (ou NEXUS_PAY_WEBHOOK_TOKEN) no Railway.
 */
function validateNexusWebhookToken(req) {
    const expected = String(process.env.NEXUSPAG_WEBHOOK_TOKEN || process.env.NEXUS_PAY_WEBHOOK_TOKEN || '').trim();
    if (!expected) {
        console.error('[WEBHOOK NEXUS] NEXUSPAG_WEBHOOK_TOKEN não configurado — recusando webhook');
        return false;
    }

    const got = req.query && req.query.token != null ? String(req.query.token).trim() : '';
    if (!got) return false;

    const he = crypto.createHash('sha256').update(expected).digest();
    const hg = crypto.createHash('sha256').update(got).digest();
    if (he.length !== hg.length) return false;
    return crypto.timingSafeEqual(he, hg);
}

module.exports = { validateNexusWebhookToken };
