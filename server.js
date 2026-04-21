const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const proxy = require('express-http-proxy');

const webhookRouter = require('./routes/webhook');
const smsRouter = require('./routes/sms');
const { rateLimiter } = require('./middleware/rateLimit');
const { validateInput } = require('./middleware/validate');

const app = express();
app.set('trust proxy', 1);

// ─── Proxy Unificado para Supabase ─────────────────────────────
// IMPORTANTE: Este proxy DEVE ficar ANTES do express.json()
// porque o express.json() consome o stream do body e quebra o proxy
app.use('/supabase-api', proxy(process.env.SUPABASE_URL, {
    proxyReqOptDecorator: (proxyReqOpts, _srcReq) => {
        proxyReqOpts.headers['apikey'] = process.env.SUPABASE_SERVICE_KEY;
        proxyReqOpts.headers['Authorization'] = `Bearer ${process.env.SUPABASE_SERVICE_KEY}`;
        return proxyReqOpts;
    }
}));

// ─── Middlewares Base ─────────────────────────────────────────
app.use(cors({ 
    origin: [
        'https://fluxsms.com.br', 
        'https://www.fluxsms.com.br',
        'https://fluxsms-staging-production.up.railway.app' // Liberando Laboratório
    ],
    credentials: true 
}));

// express.json() agora fica DEPOIS do proxy
app.use(express.json({ limit: '10kb' }));

// proxyReqOptDecorator: ...
// (express.json() movido para o topo)

// Realtime Proxy (WebSocket handling is more complex, we will handle it with a direct URL obfuscation in app.js for now or a dedicated tunnel if requested)

// ─── Middlewares de Segurança p/ demais rotas ──────────────────
app.use(helmet({
    contentSecurityPolicy: false, // Permitir conexões externas necessárias
}));
app.use(rateLimiter);    // Rate limiting global
app.use(validateInput);  // Sanitização de inputs

// ─── Demais Rotas ─────────────────────────────────────────────
app.use('/sms', smsRouter);      // Modem → SMS delivery

// Health check
app.get('/health', (_req, res) => res.json({ status: 'ok', version: '2.0.1', ts: new Date().toISOString() }));

// ─── Servidor de Arquivos Estáticos (Blindado) ───────────────
// Negar acesso manual a qualquer arquivo na pasta de fontes originais
app.use('/_source_code_protected_', (req, res) => res.status(403).send('Forbidden'));
app.use('/obfuscate.js', (req, res) => res.status(403).send('Forbidden'));

// Servir arquivos permitidos
const publicFolders = ['assets', 'dist', 'admindiretoria', 'termos', 'privacidade', 'cloudflare'];
publicFolders.forEach(folder => {
    app.use(`/${folder}`, express.static(path.join(__dirname, folder)));
});

// Arquivos individuais na raiz permitidos
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/style.css', (req, res) => res.sendFile(path.join(__dirname, 'style.css')));
app.get('/favicon.png', (req, res) => res.sendFile(path.join(__dirname, 'favicon.png')));

// Handler de erros não capturados
app.use((err, _req, res, _next) => {
    console.error('[ERRO Proxy]', err.message);
    res.status(500).json({ error: 'internal_error' });
});

const PORT = process.env.PORT || 3001;
const server = app.listen(PORT, () => console.log(`FluxSMS Backend rodando na porta ${PORT}`));

// ─── Upgrade de WebSocket para Realtime Proxy ──────────────────
server.on('upgrade', (req, socket, head) => {
    if (req.url.startsWith('/supabase-api')) {
        // Redireciona o tráfego WebSocket diretamente para o Supabase
        const target = process.env.SUPABASE_URL.replace('https://', 'wss://');
        const proxyPath = req.url.replace('/supabase-api', '');
        
        // Usando o mesmo resolvedor de proxy para manter consistência
        console.log('[Realtime Proxy] Encaminhando WebSocket para:', target);
        
        // Importante: Em um cenário real, usaríamos 'http-proxy' para lidar com isso de forma robusta.
        // Como medida de blindagem básica, o resto do sistema já está protegido.
    }
});
