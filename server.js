const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { createClient } = require('@supabase/supabase-js');

const webhookRouter = require('./routes/webhook');
const smsRouter = require('./routes/sms');
const { rateLimiter } = require('./middleware/rateLimit');
const { validateInput } = require('./middleware/validate');

const app = express();

// ─── Supabase (service_role para operações protegidas) ────────
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// Disponibiliza globalmente para rotas
app.set('supabase', supabase);

// ─── Middlewares de Segurança ─────────────────────────────────
app.use(helmet());
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10kb' })); // Limita body size
app.use(rateLimiter);    // Rate limiting global
app.use(validateInput);  // Sanitização de inputs

// ─── Rotas ────────────────────────────────────────────────────
app.use('/webhook', webhookRouter);  // Mercado Pago
app.use('/sms', smsRouter);      // Modem → SMS delivery

// Health check
app.get('/health', (_req, res) => res.json({ status: 'ok', version: '2.0.1', ts: new Date().toISOString() }));

// Handler de erros não capturados
app.use((err, _req, res, _next) => {
    console.error('[ERRO]', err.message);
    res.status(500).json({ error: 'internal_error' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`FluxSMS Backend rodando na porta ${PORT}`));
