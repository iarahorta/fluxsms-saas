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

module.exports = { rateLimiter, smsRateLimiter };
