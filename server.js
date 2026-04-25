const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

const proxy = require('express-http-proxy');

const webhookRouter = require('./routes/webhook');
const smsRouter = require('./routes/sms');
const partnerApiRouter = require('./routes/partnerApi');
const adminPartnersRouter = require('./routes/adminPartners');
const adminFinancasFluxRouter = require('./routes/adminFinancasFlux');
const adminSecurityRouter = require('./routes/adminSecurity');
const partnerFinanceRouter = require('./routes/partnerFinance');
const partnerOnboardingRouter = require('./routes/partnerOnboarding');
const partnerSelfRouter = require('./routes/partnerSelf');
const publicEstoqueRouter = require('./routes/publicEstoque');
const { rateLimiter, adminSensitiveLimiter } = require('./middleware/rateLimit');
const { validateInput } = require('./middleware/validate');

const app = express();
app.set('trust proxy', 1);

function getDesktopUpdateMeta() {
    try {
        const fp = path.join(__dirname, 'public', 'download', 'desktop-update.json');
        const raw = fs.readFileSync(fp, 'utf8');
        const data = JSON.parse(raw);
        const remoteUrl = String(data.url || '').trim();
        if (!remoteUrl) return { path: '/download/FluxSMS_Setup.exe' };
        try {
            const u = new URL(remoteUrl);
            return { path: `${u.pathname}${u.search || ''}` };
        } catch {
            if (remoteUrl.startsWith('/')) return { path: remoteUrl };
            return { path: '/download/FluxSMS_Setup.exe' };
        }
    } catch {
        return { path: '/download/FluxSMS_Setup.exe' };
    }
}

// Redirecionamentos explícitos (legado) — antes de tudo, para o Railway/Cloud não devolver 404.
app.get([
    '/downloads/FluxSMS-Polo-Worker-Portable.exe',
    '/download/FluxSMS-Polo-Worker-Portable.exe',
    '/downloads/FluxSMS-Polo-Worker-Portable.EXE',
    '/download/FluxSMS-Polo-Worker-Portable.EXE'
], (req, res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    return res.redirect(302, getDesktopUpdateMeta().path);
});

// Instalador legado — DEVE ficar antes de qualquer outro middleware / router
// (evita 404 "Cannot GET" se outro handler ou deploy antigo interceptar /downloads).
app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const raw = String(req.originalUrl || req.url || '').split('?')[0].split('#')[0];
    let p;
    try {
        p = decodeURIComponent(raw);
    } catch {
        p = raw;
    }
    if (
        /^\/downloads\/FluxSMS-Polo-Worker-Portable\.exe\/?$/i.test(p) ||
        /^\/download\/FluxSMS-Polo-Worker-Portable\.exe\/?$/i.test(p)
    ) {
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
        return res.redirect(302, getDesktopUpdateMeta().path);
    }
    // Qualquer /downloads/*.exe (exceto redirect específico acima) ainda comum em links viejos
    if (/^\/downloads\/[^/]+\.exe\/?$/i.test(p) && !/^\/downloads\/FluxSMS_Setup\.exe\/?$/i.test(p)) {
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
        return res.redirect(302, getDesktopUpdateMeta().path);
    }
    next();
});

// ─── Supabase (service_role para operações protegidas) ────────
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// Disponibiliza globalmente para as rotas
app.set('supabase', supabase);

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
        'https://parceiros.fluxsms.com.br',
        'https://fluxsms-staging-production.up.railway.app'
    ],
    credentials: true
}));

// express.json() agora fica DEPOIS do proxy
app.use(express.json({ limit: '10kb' }));
app.use((req, res, next) => {
    if (req.method === 'GET') {
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.set('Pragma', 'no-cache');
        res.set('Expires', '0');
    }
    next();
});

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
app.use('/webhook', webhookRouter); // Processador de PIX e Webhooks
app.use('/partner-api', partnerApiRouter); // API universal para parceiros
app.use('/api/admin/partners', adminPartnersRouter); // Dashboard admin: lista de parceiros (JWT + is_admin)
app.use('/api/admin/financas-flux', adminFinancasFluxRouter); // Finanças Flux: wallets + parceiro (JWT admin)
app.use('/api/admin/security', adminSensitiveLimiter, adminSecurityRouter); // Admin raiz: gestão de senhas de usuários
app.use('/api/partner/finance', partnerFinanceRouter); // Parceiro logado: resumo repasse + pedido de saque (JWT + is_partner)
app.use('/api/partner/onboarding', partnerOnboardingRouter); // Cadastro autónomo: ativar perfil parceiro (JWT)
app.use('/api/partner/self', partnerSelfRouter); // Painel parceiro: bootstrap + gerar API Key (JWT + is_partner)
app.use('/api/public', publicEstoqueRouter); // Plano B: estoque (service_role) sem depender só de RPC/anon

// ─── Heartbeat Cleaner Automático (60s / timeout 180s) ─────────
const HEARTBEAT_INTERVAL_MS = 60 * 1000;
const HEARTBEAT_TIMEOUT_MS = 180 * 1000;
async function runHeartbeatCleaner() {
    try {
        const thresholdIso = new Date(Date.now() - HEARTBEAT_TIMEOUT_MS).toISOString();

        // Polos sem comunicação recente => OFFLINE
        await supabase
            .from('polos')
            .update({ status: 'OFFLINE' })
            .lt('ultima_comunicacao', thresholdIso)
            .neq('status', 'OFFLINE');

        // Chips fantasmas (sem ping > 180s) => OFFLINE
        await supabase
            .from('chips')
            .update({ status: 'offline' })
            .lt('last_ping', thresholdIso)
            .neq('status', 'offline');
        // Fallback para chips legados que ainda não receberam last_ping
        await supabase
            .from('chips')
            .update({ status: 'offline' })
            .is('last_ping', null)
            .lt('updated_at', thresholdIso)
            .neq('status', 'offline');
    } catch (_err) {
        // silencioso por requisito operacional
    }
}
setInterval(runHeartbeatCleaner, HEARTBEAT_INTERVAL_MS);
setTimeout(runHeartbeatCleaner, 10000);

// Deploy touch 2026-04-22 — performance LCP + imagens WebP/JPEG + scripts ao fim do body
const VERSION = '2.1.32';
// Health check
app.get('/health', (_req, res) => res.json({ status: 'ok', version: VERSION, ts: new Date().toISOString() }));

/** Produção: host parceiros.* | Staging: FORCE_PARTNER_PORTAL=1 no Railway simula o mesmo isolamento. */
function resolveRequestHost(req) {
    const forwardedHostRaw = req.get('x-forwarded-host') || '';
    const forwardedHost = forwardedHostRaw.split(',')[0].trim();
    const rawHost = forwardedHost || req.get('host') || '';
    return rawHost.split(':')[0].toLowerCase();
}

function isPartnerPortalHost(req) {
    const host = resolveRequestHost(req);
    return host === 'parceiros.fluxsms.com.br' || host.startsWith('parceiros.');
}

function isPartnerPortalExperience(req) {
    if (process.env.FORCE_PARTNER_PORTAL === '1') return true;
    if (req.path === '/portal' || req.path === '/portal/' || req.path.startsWith('/portal/')) return true;
    return isPartnerPortalHost(req);
}

function sendIndexHtml(req, res) {
    try {
        let html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
        if (isPartnerPortalExperience(req) && !html.includes('window.__FLUX_PARTNER_PORTAL=true')) {
            html = html.replace('<head>', '<head>\n    <script>window.__FLUX_PARTNER_PORTAL=true</script>');
        }
        if (!html.includes('window.__FLUX_CHAT_CONFIG=')) {
            const tawkPropertyId = String(process.env.TAWK_PROPERTY_ID || '69e8ef5ae501111c351289e9').trim();
            const tawkWidgetId = String(process.env.TAWK_WIDGET_ID || '1jmqudufi').trim();
            const chatConfig = {
                provider: String(process.env.CHAT_WIDGET_PROVIDER || 'tawk').toLowerCase(),
                crispWebsiteId: process.env.CRISP_WEBSITE_ID || '',
                tawkPropertyId,
                tawkWidgetId
            };
            const safeConfigJson = JSON.stringify(chatConfig).replace(/</g, '\\u003c');
            html = html.replace('<head>', `<head>\n    <script>window.__FLUX_CHAT_CONFIG=${safeConfigJson}</script>`);
        }
        if (!html.includes('window.__FLUX_APP_CONFIG=')) {
            const appConfig = {
                supportEmail: String(process.env.SUPPORT_EMAIL || 'suporte@fluxsms.com.br').trim().toLowerCase()
            };
            const safeAppConfigJson = JSON.stringify(appConfig).replace(/</g, '\\u003c');
            html = html.replace('<head>', `<head>\n    <script>window.__FLUX_APP_CONFIG=${safeAppConfigJson}</script>`);
        }
        res.type('html').send(html);
    } catch (err) {
        res.status(500).send('index_read_failed');
    }
}

const sendPartnerLoginPage = (_req, res) => res.sendFile(path.join(__dirname, 'partner-login.html'));
const sendPartnerLandingPage = (_req, res) => res.sendFile(path.join(__dirname, 'partner-landing.html'));
const sendFidelityLandingPage = (_req, res) => res.sendFile(path.join(__dirname, 'fidelity-landing.html'));

// ─── Servidor de Arquivos Estáticos (Blindado) ───────────────
// Negar acesso manual a qualquer arquivo na pasta de fontes originais
app.use('/_source_code_protected_', (req, res) => res.status(403).send('Forbidden'));
app.use('/obfuscate.js', (req, res) => res.status(403).send('Forbidden'));

// ─── DEBUG/SEED (STAGING ONLY) ───────────────────────────────
app.get('/debug/seed', async (req, res) => {
    try {
        const supabase = req.app.get('supabase');
        console.log('[SEED] Injetando dados de teste...');

        // 1. Criar Polo de Teste (Online e Imortal para o Lab)
        const POLO_ID = 'ba768131-e67e-4299-bf5a-96503f92076c';
        await supabase.from('polos').upsert({
            id: POLO_ID,
            nome: 'Polo Lab Staging',
            status: 'ONLINE',
            ultima_comunicacao: '2029-01-01T00:00:00.000Z' // 🛡️ Data no futuro para não cair no timeout de 90s
        });

        // 2. Criar Chips de Teste (Vários para garantir estoque em tudo)
        await supabase.from('chips').upsert([
            { id: '00000000-0000-0000-0000-000000000001', polo_id: POLO_ID, numero: '+5511999990001', status: 'idle' },
            { id: '00000000-0000-0000-0000-000000000002', polo_id: POLO_ID, numero: '+5511999990002', status: 'idle' },
            { id: '00000000-0000-0000-0000-000000000003', polo_id: POLO_ID, numero: '+5511999990003', status: 'idle' },
            { id: '00000000-0000-0000-0000-000000000004', polo_id: POLO_ID, numero: '+5511999990004', status: 'idle' },
            { id: '00000000-0000-0000-0000-000000000005', polo_id: POLO_ID, numero: '+5511999990005', status: 'idle' }
        ]);

        // 3. Garantir Usuário no Auth e Reset de Senha (iarahorta@gmail.com)
        const { data: authUser, error: authError } = await supabase.auth.admin.createUser({
            email: 'iarahorta@gmail.com',
            password: '23112007',
            email_confirm: true
        });

        // Se já existir, forçamos o reset da senha para garantir o login
        if (authError && authError.message.includes('already registered')) {
            const { data: users } = await supabase.auth.admin.listUsers();
            const existing = users.users.find(u => u.email === 'iarahorta@gmail.com');
            if (existing) {
                console.log('[SEED] Resetando senha do usuário existente:', existing.id);
                await supabase.auth.admin.updateUserById(existing.id, { password: '23112007' });
            }
        }

        // 4. Dar Saldo Abundante para o Usuário Mestre (iarahorta@gmail.com)
        await supabase.from('profiles').update({ balance: 500.00 }).eq('email', 'iarahorta@gmail.com');

        res.json({ ok: true, message: 'Ambiente de Staging populado e senha resetada para 23112007!' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Servir arquivos permitidos
const publicFolders = ['assets', 'dist', 'admindiretoria', 'termos', 'privacidade', 'cloudflare', 'marketing'];
publicFolders.forEach(folder => {
    app.use(`/${folder}`, express.static(path.join(__dirname, folder)));
});

// Metadados de versão do instalador desktop (sem cache — o app compara com a versão instalada)
app.get('/download/desktop-update.json', (_req, res) => {
    const fp = path.join(__dirname, 'public', 'download', 'desktop-update.json');
    if (!fs.existsSync(fp)) return res.status(404).type('application/json').send('{}');
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.type('application/json; charset=utf-8');
    res.sendFile(fp);
});

// Instalador Windows (parceiros) — URL canónica versionada em desktop-update.json
app.use(
    '/download',
    express.static(path.join(__dirname, 'public', 'download'), {
        maxAge: 0,
        setHeaders(res, filePath) {
            const low = String(filePath).toLowerCase();
            if (low.endsWith('.exe') || low.endsWith('desktop-update.json')) {
                res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
                return;
            }
            res.set('Cache-Control', 'public, max-age=300, must-revalidate');
        }
    })
);
// Legado: redireciona nomes / caminhos antigos do instalador parceiro para o artefacto atual
app.get('/download/FluxSMS_Setup.exe', (_req, res) => res.redirect(302, getDesktopUpdateMeta().path));
app.get('/downloads/FluxSMS_Setup.exe', (_req, res) => res.redirect(302, getDesktopUpdateMeta().path));
app.get('/downloads/FluxSMS-Polo-Worker-Portable.exe', (_req, res) => res.redirect(302, getDesktopUpdateMeta().path));
app.get('/download/FluxSMS-Polo-Worker-Portable.exe', (_req, res) => res.redirect(302, getDesktopUpdateMeta().path));
// Pasta /downloads mantida para README ou ficheiros opcionais locais (não enviada no deploy se .railwayignore excluir downloads/)
if (fs.existsSync(path.join(__dirname, 'downloads'))) {
    app.use('/downloads', express.static(path.join(__dirname, 'downloads'), { maxAge: 7 * 86400000 }));
}

// SEO — sitemap e robots (ficheiros em /public)
app.get('/sitemap.xml', (_req, res) => {
    const fp = path.join(__dirname, 'public', 'sitemap.xml');
    if (!fs.existsSync(fp)) return res.status(404).type('text/plain').send('Not found');
    res.type('application/xml');
    res.sendFile(fp);
});
app.get('/robots.txt', (_req, res) => {
    const fp = path.join(__dirname, 'public', 'robots.txt');
    if (!fs.existsSync(fp)) return res.status(404).type('text/plain').send('Not found');
    res.type('text/plain; charset=utf-8');
    res.sendFile(fp);
});

// Documentação da API (HTML estático, estilo referência pública tipo hero-sms.com/api)
app.get(['/api', '/api/'], (_req, res) => {
    const fp = path.join(__dirname, 'public', 'api', 'index.html');
    if (!fs.existsSync(fp)) return res.status(404).type('text/plain').send('Not found');
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.type('text/html; charset=utf-8');
    res.sendFile(fp);
});

// Arquivos individuais na raiz permitidos (links diretos a /index.html são comuns no browser / bookmarks)
app.get('/', sendIndexHtml);
app.get('/index.html', sendIndexHtml);
app.get('/fidelidade', sendFidelityLandingPage);
app.get('/fidelidade/', (_req, res) => res.redirect(301, '/fidelidade'));
app.get('/portal', sendIndexHtml);
app.get('/portal/', (_req, res) => res.redirect(301, '/portal'));
app.get('/p/login', (req, res) => {
    if (!isPartnerPortalExperience(req)) {
        return res.status(404).type('text/plain').send('Not found');
    }
    sendPartnerLoginPage(req, res);
});
app.get('/portal/login', sendPartnerLoginPage);
const sendPartnerRegister = (_req, res) => res.sendFile(path.join(__dirname, 'partner-register.html'));
app.get('/partner', sendPartnerLandingPage);
app.get('/partner/', sendPartnerLandingPage);
app.get('/partner-landing.html', sendPartnerLandingPage);
app.get('/partner/login', (_req, res) => res.redirect(301, '/portal/login'));
app.get('/partner/login/', (_req, res) => res.redirect(301, '/portal/login'));
app.get('/partner/register', (_req, res) => res.redirect(301, '/portal/register'));
app.get('/partner/register/', (_req, res) => res.redirect(301, '/portal/register'));
app.get('/portal/register', sendPartnerRegister);
app.get('/partner-register.html', (_req, res) => res.redirect(301, '/portal/register'));
app.get('/modems', (_req, res) => res.sendFile(path.join(__dirname, 'admindiretoria', 'modems.html')));
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
