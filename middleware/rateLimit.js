const rateLimit = require('express-rate-limit');

// Rate limit geral: 100 req/min por IP
const rateLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'muitas_requisicoes', retry_after: '60s' },
    skip: (req) => req.path === '/health'  // Health check sem limite
});

// Rate limit agressivo para solicitações de SMS: 10/min por IP
const smsRateLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    message: { error: 'limite_sms_atingido', retry_after: '60s' }
});

// Webhook: limitar spam sem bloquear reentregas legítimas do gateway.
const paymentWebhookLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'limite_webhook_atingido', retry_after: '60s' }
});

// Criação de PIX (cliente autenticado): limita abuso.
const pixCreateLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'limite_pix_atingido', retry_after: '60s' }
});

// Rotas admin sensíveis: bem mais restrito.
const adminSensitiveLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 15,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'limite_admin_atingido', retry_after: '60s' }
});

module.exports = {
    rateLimiter,
    smsRateLimiter,
    paymentWebhookLimiter,
    pixCreateLimiter,
    adminSensitiveLimiter
};
