const rateLimit = require('express-rate-limit');
const crypto = require('crypto');

function partnerRateKey(req) {
    const authHeader = req.headers.authorization || '';
    const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    const apiKey = String(req.headers['x-api-key'] || bearer || '').trim();
    const hwid = String(
        req.headers['x-flux-hwid'] ||
        req.headers['x-flux-hw-id'] ||
        req.headers['x-hardware-id'] ||
        ''
    ).trim();
    if (!apiKey) return '';
    const h = crypto.createHash('sha256').update(`${apiKey}|${hwid}`).digest('hex').slice(0, 32);
    return `partner:${h}`;
}

// Rate limit geral: 100 req/min por IP (rotas públicas / mistas)
// Para /partner-api/*, o limite passa a ser por credencial (API key + HWID),
// evitando 429 quando vários PCs/workers compartilham o mesmo IP público (NAT).
const rateLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: (req) => {
        const p = String(req.path || '');
        if (p.startsWith('/partner-api') && partnerRateKey(req)) return 2000;
        return 100;
    },
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'muitas_requisicoes', retry_after: '60s' },
    skip: (req) => req.path === '/health',  // Health check sem limite
    keyGenerator: (req) => {
        const p = String(req.path || '');
        if (p.startsWith('/partner-api')) {
            const k = partnerRateKey(req);
            if (k) return k;
        }
        const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
        return xf || req.ip || 'unknown';
    }
});

// Rate limit agressivo para solicitações de SMS: 10/min por IP
const smsRateLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    message: { error: 'limite_sms_atingido', retry_after: '60s' }
});

function ipKey(req) {
    const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    return xf || req.ip || 'unknown';
}

/** Limite agressivo para criação de PIX (anti-spam / brute em recargas). */
const pixCreateLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 15,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'limite_pix_create', retry_after: '60s' },
    keyGenerator: (req) => `pix_create:${ipKey(req)}`
});

/** Webhooks de pagamento: evita flood no endpoint de retorno. */
const paymentWebhookLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'limite_webhook_pagamento', retry_after: '60s' },
    keyGenerator: (req) => `payhook:${ipKey(req)}:${String(req.path || '')}`
});

/** Rotas administrativas sensíveis (ex.: reset de password) — anti brute force por IP. */
const adminSensitiveLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 40,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'limite_admin_sensivel', retry_after: '15m' },
    keyGenerator: (req) => `admin_sensitive:${ipKey(req)}`
});

module.exports = {
    rateLimiter,
    smsRateLimiter,
    pixCreateLimiter,
    paymentWebhookLimiter,
    adminSensitiveLimiter
};
