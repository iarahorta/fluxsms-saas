/**
 * Sanitização básica de inputs para prevenir SQL Injection e XSS.
 * Supabase usa queries parametrizadas, então o risco é mínimo,
 * mas esta camada extra garante que inputs maliciosos não entrem sequer no log.
 */
function validateInput(req, _res, next) {
    const sanitize = (value) => {
        if (typeof value !== 'string') return value;
        let s = value
            .replace(/<\/script/gi, '')
            .replace(/<script/gi, '')
            .replace(/javascript:/gi, '')
            .replace(/on\w+\s*=/gi, '')     // handlers inline (onclick=, onerror=)
            .replace(/[<>]/g, '')           // Remove < > (XSS básico)
            .replace(/;|--|\/\*/g, '')       // Remove delimitadores SQL
            .trim()
            .slice(0, 500);                 // Limita tamanho
        return s;
    };

    const sanitizeObj = (obj) => {
        if (!obj || typeof obj !== 'object') return obj;
        const clean = {};
        for (const [k, v] of Object.entries(obj)) {
            clean[k] = typeof v === 'object' ? sanitizeObj(v) : sanitize(v);
        }
        return clean;
    };

    req.body   = sanitizeObj(req.body);
    req.query  = sanitizeObj(req.query);
    req.params = sanitizeObj(req.params);

    next();
}

module.exports = { validateInput };
