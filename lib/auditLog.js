const crypto = require('crypto');

function clientIp(req) {
    const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    return xf || String(req.ip || '').trim() || null;
}

function ua(req) {
    const s = String(req.headers['user-agent'] || '').trim();
    return s ? s.slice(0, 500) : null;
}

function hashApiKeyPreview(rawKey) {
    const s = String(rawKey || '').trim();
    if (!s) return null;
    return crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);
}

/**
 * Registo de auditoria (tabela interna). Falhas são silenciosas para não quebrar fluxo.
 */
async function logBalanceAudit(supabase, row) {
    try {
        const payload = {
            event_type: String(row.event_type || 'unknown').slice(0, 80),
            gateway: row.gateway != null ? String(row.gateway).slice(0, 40) : null,
            external_ref: row.external_ref != null ? String(row.external_ref).slice(0, 200) : null,
            beneficiary_user_id: row.beneficiary_user_id || null,
            amount: Number(row.amount || 0),
            currency: String(row.currency || 'BRL').slice(0, 8),
            partner_profile_id: row.partner_profile_id || null,
            partner_api_key_id: row.partner_api_key_id || null,
            partner_api_key_prefix: row.partner_api_key_prefix != null
                ? String(row.partner_api_key_prefix).slice(0, 32)
                : null,
            actor_ip: row.actor_ip != null ? String(row.actor_ip).slice(0, 80) : null,
            user_agent: row.user_agent != null ? String(row.user_agent).slice(0, 500) : null,
            meta: row.meta && typeof row.meta === 'object' ? row.meta : {}
        };
        const { error } = await supabase.from('flux_balance_audit_log').insert(payload);
        if (error) console.warn('[AUDIT] insert falhou:', error.message);
    } catch (e) {
        console.warn('[AUDIT] insert exceção:', e.message || e);
    }
}

module.exports = { logBalanceAudit, clientIp, ua, hashApiKeyPreview };
