/**
 * FluxSMS - Frontend Business Logic (Realtime & Supabase Integration)
 */

// === SUPABASE CLIENT ===
const SUPABASE_URL = 'https://ewwhywbwtqwtuujemtfk.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV3d2h5d2J3dHF3dHV1amVtdGZrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYwOTAzMjYsImV4cCI6MjA5MTY2NjMyNn0.pgv9mkWHlq6wam7-BrN-zmlNDgyf-sDFTc1KT8IjvuU';

let db = null;
let currentUser = null;

db = window.supabase?.createClient(SUPABASE_URL, SUPABASE_ANON);

/** Portal parceiro só é considerado ativo quando a URL contém /portal. */
const IS_PORTAL_PATH = typeof window !== 'undefined' && window.location.pathname.startsWith('/portal');
const IS_PARTNER_PORTAL = typeof window !== 'undefined' && window.__FLUX_PARTNER_PORTAL === true && IS_PORTAL_PATH;
const PARTNER_LOGIN_PATH = window.location.pathname.startsWith('/portal') ? '/portal/login' : '/p/login';
const ROOT_ADMIN_EMAIL = 'iarachorta@gmail.com';
const SUPPORT_EMAIL = String(window.__FLUX_APP_CONFIG?.supportEmail || 'suporte@fluxsms.com.br').toLowerCase();

// === LISTA DE SERVIÇOS ===
let SERVICES = [
    { id: 'whatsapp', name: 'WhatsApp', price: 6.10 },
    { id: 'telegram', name: 'Telegram', price: 4.00 },
    { id: 'google', name: 'Google', price: 1.50 },
    { id: 'instagram', name: 'Instagram', price: 2.00 }
];
let userCustomPrices = {};
let currentUserIsAdmin = false;
let currentUserIsPartner = false;
const LAUNCH_PROMO_START_ISO = '2026-04-22T00:00:00-03:00';
const LAUNCH_PROMO_DAYS = 15;
const WHATSAPP_LEVELS = [
    { key: 'PADRAO', minSpent: 0, price: 7.50, label: 'Padrão', badgeClass: 'badge-bronze' },
    { key: 'BRONZE', minSpent: 200.01, price: 7.00, label: 'Bronze', badgeClass: 'badge-bronze' },
    { key: 'PRATA', minSpent: 1000.01, price: 6.50, label: 'Prata', badgeClass: 'badge-prata' },
    { key: 'OURO', minSpent: 3000.01, price: 6.10, label: 'Ouro', badgeClass: 'badge-ouro' }
];

/** Staging: true = botão/menu Parceiros visíveis para qualquer usuário logado (API /api/admin/partners continua exigindo admin). Coloque false quando is_admin estiver correto no Supabase. */
const PARTNER_UI_FORCE_VISIBLE = true;

// === ESTADO GLOBAL ===
let activeSessions = {};
let chipsDisponiveis = 0;
let serviceStocks = {};
let isRealtimeActive = false;
let chatWidgetBooted = false;
let tawkVisibilitySyncStarted = false;
let profileCompletionShown = false;

// === ELEMENTOS ===
const landingView = document.getElementById('landing-view');
const dashboardView = document.getElementById('dashboard-view');
const authModal = document.getElementById('authModal');
const servicesGrid = document.getElementById('services-grid');
const activeNumbers = document.getElementById('active-numbers');
const searchInput = document.getElementById('service-search');

function shouldBootChatWidget() {
    if (!currentUser) return false;
    if (IS_PARTNER_PORTAL) return true;
    return dashboardView && dashboardView.style.display !== 'none';
}

function bootChatWidget() {
    if (chatWidgetBooted || !shouldBootChatWidget()) return;
    const cfg = window.__FLUX_CHAT_CONFIG || {};
    const tawkPropertyId = String(cfg.tawkPropertyId || '').trim();
    const tawkWidgetId = String(cfg.tawkWidgetId || '').trim();
    const hasCrisp = !!cfg.crispWebsiteId;
    const hasTawk = !!(tawkPropertyId && tawkWidgetId);

    // Prioridade total para Tawk quando IDs estiverem presentes.
    if (hasTawk) {
        window.Tawk_API = window.Tawk_API || {};
        window.Tawk_LoadStart = new Date();
        window.Tawk_API.visitor = {
            name: 'Cliente FluxSMS'
        };
        window.Tawk_API.onLoad = function () {
            try {
                window.Tawk_API.setAttributes({
                    name: 'Cliente FluxSMS'
                }, function (_error) { });
                window.Tawk_API.localize = {
                    en: {
                        chat_window: {
                            live_chat: 'Suporte FluxSMS',
                            away_message: 'No momento não estamos online, deixe sua mensagem.',
                            send_message: 'Enviar Mensagem',
                            input_placeholder: 'Digite sua dúvida aqui...'
                        }
                    }
                };
            } catch (_e) { }
        };
        const s1 = document.createElement('script');
        s1.async = true;
        // URL oficial do Tawk (sem sufixo /default quando widgetId já é informado)
        s1.src = `https://embed.tawk.to/${tawkPropertyId}/${tawkWidgetId}`;
        s1.charset = 'UTF-8';
        s1.setAttribute('crossorigin', '*');
        s1.id = 'flux-tawk-script';
        document.head.appendChild(s1);
        chatWidgetBooted = true;
        ensureTawkWidgetVisible();
        return;
    }

    if (provider === 'crisp' && hasCrisp) {
        window.$crisp = window.$crisp || [];
        window.CRISP_WEBSITE_ID = cfg.crispWebsiteId;
        const s = document.createElement('script');
        s.src = 'https://client.crisp.chat/l.js';
        s.async = true;
        document.head.appendChild(s);
        chatWidgetBooted = true;
        return;
    }
}

function ensureTawkWidgetVisible() {
    if (tawkVisibilitySyncStarted) return;
    tawkVisibilitySyncStarted = true;
    const run = () => {
        try {
            if (window.Tawk_API && typeof window.Tawk_API.showWidget === 'function') {
                window.Tawk_API.showWidget();
            }
        } catch (_e) { }
    };
    run();
    setInterval(() => {
        if (!shouldBootChatWidget()) return;
        const hasScript = !!document.getElementById('flux-tawk-script');
        if (!hasScript && !chatWidgetBooted) {
            bootChatWidget();
        }
        run();
    }, 5000);
}

function unscrambleSMS(text) {
    try {
        if (!text || text === '------') return text;
        // Base64 Decode -> Invert
        const decoded = atob(text);
        return decoded.split('').reverse().join('');
    } catch (e) { return text; }
}

// === INICIALIZAÇÃO ===
async function init() {
    if (!db) {
        console.warn('Supabase não configurado.');
        renderServices(SERVICES);
        return;
    }

    if (IS_PARTNER_PORTAL) {
        document.body.classList.add('flux-partner-portal');
        document.title = 'FluxSMS | Portal Parceiros';
    } else {
        document.body.classList.remove('flux-partner-portal');
    }

    const { data: { session } } = await db.auth.getSession();
    if (IS_PARTNER_PORTAL && !session) {
        window.location.replace(PARTNER_LOGIN_PATH);
        return;
    }

    toggleViews(session);
    if (!IS_PARTNER_PORTAL && (window.location.pathname === '/' || window.location.pathname === '/index.html')) {
        forceClientHomeButtons();
    }

    setupRealtimeChips();

    // 🧹 GATILHO DO GARI: monitora ligação das estações e estorna saldo se houver queda
    // Run once at start and then every 30 seconds
    const runGari = async () => { try { await db.rpc('rpc_monitorar_e_estornar_v2'); } catch (e) { } };
    runGari();
    setInterval(runGari, 30000);

    if (session) {
        currentUser = session.user;
        if (PARTNER_UI_FORCE_VISIBLE) {
            const pw = document.getElementById('partner-header-wrap');
            const np = document.getElementById('nav-partners');
            if (pw) pw.style.display = 'inline-flex';
            if (np) np.style.display = 'flex';
        }
        await updateUIForUser();
        bootChatWidget();
        if (!currentUserIsPartner) {
            fetchGlobalServices().catch(e => console.log("Erro ao carregar preços"));
            await fetchUserCustomPrices();
            loadActiveSessions();
            loadChipsCount();
            renderServices(SERVICES);
        } else {
            renderServices([]);
            loadPartnerChipsMonitor();
            showView('dashboard');
        }
    } else if (!IS_PARTNER_PORTAL) {
        fetchGlobalServices().catch(e => console.log("Erro ao carregar preços"));
        loadChipsCount();
        renderServices(SERVICES);
    }

    if (searchInput) {
        searchInput.addEventListener('input', () => {
            if (currentUserIsPartner) return;
            const q = searchInput.value.toLowerCase();
            const filtered = SERVICES.filter(s => s.name.toLowerCase().includes(q));
            renderServices(filtered);
        });
    }

    const partnerWithdrawAmt = document.getElementById('partner-withdraw-amount');
    if (partnerWithdrawAmt) {
        partnerWithdrawAmt.addEventListener('input', () => {
            updatePartnerWithdrawButtonState(_partnerFinanceSummaryCache);
        });
    }

    const parceiroLogin = new URLSearchParams(window.location.search).get('parceiro') === 'login';
    if (!IS_PARTNER_PORTAL && !session && authModal && parceiroLogin) {
        authModal.style.display = 'flex';
        const login = document.getElementById('loginForm');
        const signup = document.getElementById('signupForm');
        if (login && signup) {
            login.style.display = 'block';
            signup.style.display = 'none';
        }
        history.replaceState({}, '', '/');
    }

    db.auth.onAuthStateChange(async (event, session) => {
        if (event === 'SIGNED_IN') {
            currentUser = session?.user;
            if (!IS_PARTNER_PORTAL && authModal) authModal.style.display = 'none';
            toggleViews(session);
            if (session) {
                if (PARTNER_UI_FORCE_VISIBLE) {
                    const pw = document.getElementById('partner-header-wrap');
                    const np = document.getElementById('nav-partners');
                    if (pw) pw.style.display = 'inline-flex';
                    if (np) np.style.display = 'flex';
                }
                await updateUIForUser();
                bootChatWidget();
                if (!currentUserIsPartner) {
                    loadActiveSessions();
                    setupRealtime();
                } else {
                    loadPartnerChipsMonitor();
                    showView('dashboard');
                }
            }
        } else if (event === 'SIGNED_OUT') {
            currentUser = null;
            profileCompletionShown = false;
            currentUserIsAdmin = false;
            currentUserIsPartner = false;
            document.body.classList.remove('partner-mode');
            if (IS_PARTNER_PORTAL) {
                window.location.replace(PARTNER_LOGIN_PATH);
                return;
            }
            const partnerWrap = document.getElementById('partner-header-wrap');
            const navPartners = document.getElementById('nav-partners');
            if (partnerWrap) partnerWrap.style.display = 'none';
            if (navPartners) navPartners.style.display = 'none';
            toggleViews(null);
            if (!IS_PARTNER_PORTAL && landingView.style.display === 'none') {
                window.location.reload();
            }
        }
    });
}

function forceClientHomeButtons() {
    const ctaButtons = document.querySelectorAll('.btn-primary-lp, .btn-secondary-lp');
    ctaButtons.forEach((btn) => {
        btn.style.display = 'inline-flex';
        btn.style.visibility = 'visible';
        btn.style.opacity = '1';
        btn.style.pointerEvents = 'auto';
    });
}

function toggleViews(session) {
    document.body.classList.toggle('app-dashboard-mode', !!session);
    if (IS_PARTNER_PORTAL) {
        landingView.style.display = 'none';
        if (session) {
            dashboardView.style.display = 'block';
            showView('dashboard');
        } else {
            dashboardView.style.display = 'none';
        }
        return;
    }
    if (session) {
        landingView.style.display = 'none';
        dashboardView.style.display = 'block';
        showView('dashboard');
    } else {
        landingView.style.display = 'block';
        dashboardView.style.display = 'none';
    }
}

// === NAVEGAÇÃO DE ABAS (SPA) ===
window.showView = function (viewName) {
    console.log("Exibindo view:", viewName);

    if (IS_PARTNER_PORTAL && (viewName === 'my-numbers' || viewName === 'history')) {
        viewName = 'dashboard';
    }

    if (currentUserIsPartner && (viewName === 'my-numbers' || viewName === 'history')) {
        viewName = 'dashboard';
    }

    if (viewName === 'partners' && !currentUserIsAdmin && !PARTNER_UI_FORCE_VISIBLE && !currentUserIsPartner) {
        alert('Acesso restrito a parceiros ou administradores.');
        return;
    }

    // Esconde todas as abas
    document.querySelectorAll('.app-view').forEach(v => v.style.display = 'none');

    // Limpa classe active
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

    // Mostra alvo
    const target = document.getElementById(`view-${viewName}`);
    if (target) {
        target.style.display = (viewName === 'dashboard' ? 'grid' : 'block');
        const nav = document.getElementById(`nav-${viewName}`);
        if (nav) nav.classList.add('active');
    }

    if (viewName === 'my-numbers') loadMyNumbers();
    if (viewName === 'history') loadTransactionHistory();
    if (viewName === 'security') loadSecurityPanel();
    if (viewName === 'partners') loadPartnerProfiles();
    if (viewName === 'dashboard' && currentUserIsPartner) loadPartnerChipsMonitor();
    if (viewName === 'dashboard') bootChatWidget();
};

function syncPartnerPanelsVisibility() {
    const finance = document.getElementById('partner-finance-panel');
    const adminBlk = document.getElementById('partner-admin-block');
    if (finance) finance.style.display = currentUserIsPartner ? 'block' : 'none';
    if (adminBlk) adminBlk.style.display = currentUserIsAdmin ? 'block' : 'none';
}

async function loadMyNumbers() {
    const tbody = document.querySelector('#table-my-numbers tbody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;">Carregando histórico...</td></tr>';

    const { data, error } = await db.from('activations').select('*').eq('user_id', currentUser.id).eq('status', 'received').order('created_at', { ascending: false });

    if (error || !data) {
        console.error("Erro ao carregar sessões:", error);
        tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;">Nenhum código recebido ainda.</td></tr>';
        return;
    }

    tbody.innerHTML = data.map(a => `
        <tr>
            <td>${new Date(a.created_at).toLocaleString('pt-BR')}</td>
            <td><strong>${a.service_name}</strong></td>
            <td style="font-family: monospace;">${a.phone_number}</td>
            <td style="color: var(--flux-gold); font-weight: 800;">${a.sms_code}</td>
        </tr>
    `).join('');
}

async function loadTransactionHistory() {
    const tbody = document.querySelector('#table-user-history tbody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;">Carregando extrato...</td></tr>';

    const { data, error } = await db.from('transactions').select('*').eq('user_id', currentUser.id).order('created_at', { ascending: false });

    if (error || !data) {
        tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;">Nenhuma transação encontrada.</td></tr>';
        return;
    }

    tbody.innerHTML = data.map(t => {
        const typeLabel = t.type === 'credit' ? '📈 CRÉDITO' : (t.type === 'debit' ? '📉 DÉBITO' : '🔄 REEMBOLSO');
        const typeColor = t.type === 'credit' ? '#00ff00' : (t.type === 'debit' ? '#ffffff' : '#D4AF37');
        return `
        <tr>
            <td>${new Date(t.created_at).toLocaleString('pt-BR')}</td>
            <td style="color: ${typeColor}; font-weight: bold; font-size: 0.75rem;">${typeLabel}</td>
            <td style="color: ${typeColor}; font-weight: 800;">R$ ${t.amount.toFixed(2)}</td>
            <td style="font-size: 0.8rem; color: rgba(255,255,255,0.6);">${t.description}</td>
        </tr>
    `}).join('');
}

function normalizeWhatsapp(value) {
    const digits = String(value || '').replace(/\D/g, '');
    if (digits.length < 10 || digits.length > 13) return '';
    if (digits.startsWith('55')) return `+${digits}`;
    return `+55${digits}`;
}

async function upsertContactProfile({ whatsapp, preferredOperator }) {
    if (!db || !currentUser) return { ok: false, error: 'no_session' };
    const patch = {};
    if (whatsapp) patch.whatsapp = whatsapp;
    if (preferredOperator) patch.preferred_operator = preferredOperator;
    if (!Object.keys(patch).length) return { ok: true };
    const { error } = await db.from('profiles').update(patch).eq('id', currentUser.id);
    return error ? { ok: false, error: error.message } : { ok: true };
}

// === AUTHENTICATION ===
async function handleAuth(type) {
    try {
        if (!db) return;
        if (type === 'login') {
            const email = document.getElementById('auth-email').value;
            const password = document.getElementById('auth-password').value;
            const { error } = await db.auth.signInWithPassword({ email, password });
            if (error) alert('Falha no login: ' + error.message);
        } else {
            const email = document.getElementById('reg-email').value;
            const password = document.getElementById('reg-password').value;
            const name = document.getElementById('reg-name').value;
            const rawWhatsapp = document.getElementById('reg-whatsapp')?.value || '';
            const whatsapp = normalizeWhatsapp(rawWhatsapp);
            if (!email || !password || !name || !whatsapp) { alert("Preencha todos os campos, incluindo WhatsApp com DDD."); return; }
            const { data, error } = await db.auth.signUp({
                email,
                password,
                options: { data: { full_name: name, whatsapp } }
            });
            if (error) { alert('Erro: ' + (error.message || 'Falha no cadastro (verifique as variáveis de ambiente)')); return; }
            if (!data.session && data.user) await db.auth.signInWithPassword({ email, password });
            const { data: { session } } = await db.auth.getSession();
            if (session?.user?.id) {
                currentUser = session.user;
                await upsertContactProfile({ whatsapp });
            }
        }
    } catch (err) { console.error("Erro no handleAuth:", err); }
}

async function handleLogout() {
    await db.auth.signOut();
}

function openProfileCompletionModal(initialWhatsapp) {
    const modal = document.getElementById('profileCompletionModal');
    const input = document.getElementById('profile-whatsapp');
    const msg = document.getElementById('profile-completion-msg');
    if (!modal || !input) return;
    if (msg) msg.textContent = `Canal oficial de suporte: ${SUPPORT_EMAIL}`;
    input.value = initialWhatsapp || '';
    modal.style.display = 'flex';
}

window.closeProfileCompletionModal = function () {
    const modal = document.getElementById('profileCompletionModal');
    if (modal) modal.style.display = 'none';
};

window.submitProfileCompletion = async function () {
    const input = document.getElementById('profile-whatsapp');
    const msg = document.getElementById('profile-completion-msg');
    const normalized = normalizeWhatsapp(input ? input.value : '');
    if (!normalized) {
        if (msg) msg.textContent = 'Informe um WhatsApp válido com DDD.';
        return;
    }
    const res = await upsertContactProfile({ whatsapp: normalized });
    if (!res.ok) {
        if (msg) msg.textContent = `Falha ao salvar: ${res.error || 'erro desconhecido'}`;
        return;
    }
    if (msg) msg.textContent = 'WhatsApp salvo com sucesso.';
    setTimeout(() => {
        window.closeProfileCompletionModal();
    }, 700);
};

window.saveOperatorPreference = async function (operator) {
    const val = ['any', 'vivo', 'claro', 'tim', 'oi'].includes(operator) ? operator : 'any';
    await upsertContactProfile({ preferredOperator: val });
};

function loadSecurityPanel() {
    const adminBlock = document.getElementById('security-admin-block');
    if (adminBlock) {
        const canManageOthers = currentUserIsAdmin && currentUser?.email?.toLowerCase() === ROOT_ADMIN_EMAIL;
        adminBlock.style.display = canManageOthers ? 'block' : 'none';
    }
    const selfMsg = document.getElementById('security-self-msg');
    const adminMsg = document.getElementById('security-admin-msg');
    if (selfMsg) selfMsg.textContent = '';
    if (adminMsg) adminMsg.textContent = '';
}

window.submitSelfPasswordChange = async function () {
    const passEl = document.getElementById('security-self-password');
    const confEl = document.getElementById('security-self-password-confirm');
    const msgEl = document.getElementById('security-self-msg');
    const password = passEl ? passEl.value : '';
    const confirm = confEl ? confEl.value : '';

    if (!password || password.length < 8) {
        if (msgEl) msgEl.textContent = 'A senha precisa ter pelo menos 8 caracteres.';
        return;
    }
    if (password !== confirm) {
        if (msgEl) msgEl.textContent = 'A confirmação da senha não confere.';
        return;
    }

    const { error } = await db.auth.updateUser({ password });
    if (error) {
        if (msgEl) msgEl.textContent = 'Falha ao atualizar senha: ' + error.message;
        return;
    }

    if (passEl) passEl.value = '';
    if (confEl) confEl.value = '';
    if (msgEl) msgEl.textContent = 'Senha atualizada com sucesso.';
};

window.submitAdminPasswordChange = async function () {
    const msgEl = document.getElementById('security-admin-msg');
    const emailEl = document.getElementById('security-admin-email');
    const passEl = document.getElementById('security-admin-password');
    const email = emailEl ? emailEl.value.trim().toLowerCase() : '';
    const newPassword = passEl ? passEl.value : '';

    const canManageOthers = currentUserIsAdmin && currentUser?.email?.toLowerCase() === ROOT_ADMIN_EMAIL;
    if (!canManageOthers) {
        if (msgEl) msgEl.textContent = 'Apenas a conta admin autorizada pode trocar senha de outros usuários.';
        return;
    }
    if (!email) {
        if (msgEl) msgEl.textContent = 'Informe o e-mail do usuário.';
        return;
    }
    if (!newPassword || newPassword.length < 8) {
        if (msgEl) msgEl.textContent = 'A nova senha precisa ter no mínimo 8 caracteres.';
        return;
    }

    const { data: { session } } = await db.auth.getSession();
    if (!session) {
        if (msgEl) msgEl.textContent = 'Sessão expirada. Faça login novamente.';
        return;
    }

    try {
        const res = await fetch(`${BACKEND_URL}/api/admin/security/reset-password`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${session.access_token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ email, new_password: newPassword })
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok || !j.ok) {
            if (msgEl) msgEl.textContent = 'Falha: ' + (j.detail || j.error || res.statusText);
            return;
        }

        if (emailEl) emailEl.value = '';
        if (passEl) passEl.value = '';
        if (msgEl) msgEl.textContent = 'Senha do usuário atualizada com sucesso.';
    } catch (err) {
        if (msgEl) msgEl.textContent = 'Erro de rede: ' + (err.message || String(err));
    }
};

// === PIX ===
const BACKEND_URL = '__BACKEND_URL__'.includes('http') && !'__BACKEND_URL__'.includes('localhost')
    ? '__BACKEND_URL__'
    : (window.location.hostname.includes('railway.app') ? window.location.origin : 'https://fluxsms-staging-production.up.railway.app');
let initialBalance = 0;

let _partnerApiKeyPlainCache = '';
let _partnerMarginPercent = 60;
let _partnerBootstrapPartner = null;
let _partnerBootstrapUserEmail = '';
let _partnerBootstrapUserName = '';
let _partnerBootstrapKeyStatus = '';

async function loadPartnerAutonomyStrip() {
    const strip = document.getElementById('partner-autonomy-strip');
    if (!strip || !db || !currentUserIsPartner) return;
    strip.style.display = 'block';
    const keyBox = document.getElementById('partner-lux-keybox');
    const keyToggle = document.getElementById('partner-access-toggle');
    if (keyBox) keyBox.style.display = 'none';
    if (keyToggle) {
        keyToggle.textContent = 'Mostrar chave de acesso';
        keyToggle.setAttribute('aria-expanded', 'false');
    }
    const finLine = document.getElementById('partner-strip-finance-line');
    const dl = document.getElementById('partner-strip-download');
    const keyField = document.getElementById('partner-api-key-field');
    const keyHint = document.getElementById('partner-key-hint');
    if (keyField) {
        keyField.value = '';
        keyField.type = 'text';
        keyField.placeholder = 'A carregar…';
    }
    if (finLine) finLine.textContent = '…';
    try {
        const { data: { session } } = await db.auth.getSession();
        if (!session) return;
        const res = await fetch(`${BACKEND_URL}/api/partner/self/bootstrap`, {
            headers: { Authorization: `Bearer ${session.access_token}` }
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok || !j.ok) {
            if (keyField) keyField.placeholder = j.detail || j.error || res.statusText;
            return;
        }
        _partnerBootstrapUserEmail = (j.user_email && String(j.user_email).trim()) || '';
        _partnerBootstrapUserName = (j.user_name && String(j.user_name).trim()) || '';
        _partnerBootstrapKeyStatus = (j.api_key_status && String(j.api_key_status).trim()) || '';
        _partnerApiKeyPlainCache = j.api_key_plain || '';
        if (j.partner && j.partner.repasse_percent != null) {
            _partnerMarginPercent = Number(j.partner.repasse_percent);
        } else if (j.finance && j.finance.rules && j.finance.rules.repasse_percent != null) {
            _partnerMarginPercent = Number(j.finance.rules.repasse_percent);
        }
        if (keyField) {
            keyField.value = _partnerApiKeyPlainCache || '';
            keyField.type = 'text';
            if (_partnerApiKeyPlainCache) {
                keyField.placeholder = '';
            } else if (_partnerBootstrapKeyStatus === 'decrypt_failed') {
                keyField.placeholder = 'Erro do servidor ao ler a chave (cofre).';
            } else {
                keyField.placeholder = 'Sem API Key ativa — use «Gerar API Key» no admin.';
            }
        }
        if (keyHint) {
            if (_partnerApiKeyPlainCache) {
                keyHint.textContent = 'Guarde esta chave em local seguro. Cada perfil tem uma chave de integração associada à sua conta.';
            } else if (_partnerBootstrapKeyStatus === 'decrypt_failed') {
                keyHint.textContent = 'Não foi possível carregar a chave de integração. Contacte a FluxSMS.';
            } else {
                keyHint.textContent = 'Peça à equipa FluxSMS para ativar a chave de integração do seu perfil.';
            }
        }
        const t = (j.finance && j.finance.totals) ? j.finance.totals : {};
        if (finLine) {
            finLine.textContent = `Repasse (${Number(_partnerMarginPercent || 60)}%): liberado R$ ${Number(t.repasse_liberado || 0).toFixed(2)} · Disponível saque R$ ${Number(t.disponivel_para_solicitar || 0).toFixed(2)} (mín. R$ 400)`;
        }
        if (dl) {
            const raw = (j.worker_download_url || '').trim();
            const broken = /Polo-Worker-Portable|\/downloads\//i.test(raw);
            const href = broken || !raw ? '/download/FluxSMS.0.5.2.exe' : raw;
            dl.href = href;
            dl.setAttribute('download', 'FluxSMS.0.5.2.exe');
            dl.onclick = function (ev) {
                ev.preventDefault();
                const a = document.createElement('a');
                a.href = href;
                a.download = 'FluxSMS.0.5.2.exe';
                a.rel = 'noopener';
                document.body.appendChild(a);
                a.click();
                a.remove();
            };
        }
        _partnerBootstrapPartner = j.partner || null;
        await renderPartnerProfileStaticFromSession();
        updatePartnerProfileApiPreview();
        loadPartnerChipsMonitor();
    } catch (e) {
        if (keyField) keyField.placeholder = e.message || String(e);
    }
}

async function renderPartnerProfileStaticFromSession() {
    if (!currentUserIsPartner || !db) return;
    const { data: { session } } = await db.auth.getSession();
    const u = session?.user;
    const emailEl = document.getElementById('partner-profile-email');
    const nameEl = document.getElementById('partner-profile-name');
    const codeEl = document.getElementById('partner-profile-code');
    if (emailEl) emailEl.textContent = _partnerBootstrapUserEmail || u?.email || '—';
    const metaName = u?.user_metadata?.full_name || u?.user_metadata?.name;
    if (nameEl) nameEl.textContent = _partnerBootstrapUserName || metaName || '—';
    if (codeEl) codeEl.textContent = (_partnerBootstrapPartner && _partnerBootstrapPartner.partner_code) ? _partnerBootstrapPartner.partner_code : '—';
}

function updatePartnerProfileApiPreview() {
    const el = document.getElementById('partner-profile-api-preview');
    if (!el) return;
    const k = _partnerApiKeyPlainCache || '';
    if (!k) {
        if (_partnerBootstrapKeyStatus === 'decrypt_failed') {
            el.textContent = '— (erro cofre)';
        } else if (_partnerBootstrapKeyStatus === 'no_active_key') {
            el.textContent = '— (gere a chave no admin)';
        } else {
            el.textContent = '— (a carregar…)';
        }
        return;
    }
    el.textContent = k.length > 18 ? `${k.slice(0, 10)}…${k.slice(-6)}` : k;
}

function ensurePartnerProfileKeysVisible() {
    /* painel antigo removido — fluxo único na faixa luxo */
}

window.togglePartnerProfileKeysPanel = function (ev) {
    if (ev) ev.preventDefault();
    const body = document.getElementById('partner-profile-keys-body');
    const btn = document.getElementById('partner-profile-keys-toggle');
    const chev = document.getElementById('partner-profile-keys-chevron');
    if (!body || !btn) return;
    const opening = body.style.display === 'none' || body.style.display === '';
    body.style.display = opening ? 'block' : 'none';
    btn.setAttribute('aria-expanded', opening ? 'true' : 'false');
    if (chev) chev.textContent = opening ? '▴' : '▾';
};

function renderPartnerPolosKeysList(polos) {
    const wrap = document.getElementById('partner-polos-keys-list');
    if (!wrap) return;
    const list = polos || [];
    if (!list.length) {
        wrap.innerHTML = '<p class="partner-lux-hint" style="margin:0; color: rgba(255,255,255,0.55);">Ainda não há estação vinculada. A equipa FluxSMS liga a sua estação e os chips passam a aparecer aqui automaticamente.</p>';
        return;
    }
    wrap.innerHTML = list.map((p) => {
        const nome = escapeHtml(p.nome || 'Estação');
        const chave = p.chave_acesso || '';
        const chJson = JSON.stringify(chave);
        return `<div class="partner-polo-key-card"><h4>${nome}</h4><div class="partner-polo-key-row"><code class="pk-code">${escapeHtml(chave)}</code><button type="button" class="btn-partner-lux partner-autonomy-btn" onclick="copyPartnerPoloKey(${chJson})">COPIAR CHAVE</button></div></div>`;
    }).join('');
}

window.copyPartnerPoloKey = async function (key) {
    const k = key ? String(key) : '';
    if (!k) return;
    try {
        await navigator.clipboard.writeText(k);
        alert('Chave copiada com sucesso.');
    } catch {
        window.prompt('Copie manualmente:', k);
    }
};

window.copyPartnerApiKey = async function () {
    if (!_partnerApiKeyPlainCache) {
        alert('Chave de integração indisponível neste painel. Contacte a FluxSMS.');
        return;
    }
    try {
        await navigator.clipboard.writeText(_partnerApiKeyPlainCache);
        alert('Chave de integração copiada. Cole no FluxSMS Desktop (campo de chave de integração).');
    } catch {
        window.prompt('Copie manualmente:', _partnerApiKeyPlainCache);
    }
    updatePartnerProfileApiPreview();
};

window.togglePartnerAccessBox = function (ev) {
    if (ev) ev.preventDefault();
    const box = document.getElementById('partner-lux-keybox');
    const btn = document.getElementById('partner-access-toggle');
    if (!box || !btn) return;
    const opening = box.style.display === 'none' || box.style.display === '';
    box.style.display = opening ? 'block' : 'none';
    btn.textContent = opening ? 'Ocultar chave de acesso' : 'Mostrar chave de acesso';
    btn.setAttribute('aria-expanded', opening ? 'true' : 'false');
};

async function loadPartnerChipsMonitor() {
    const tbody = document.querySelector('#table-partner-chips-monitor tbody');
    const tableChips = document.getElementById('table-partner-chips-monitor');
    if (!tbody || !currentUserIsPartner || !db) return;
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;">A carregar…</td></tr>';
    try {
        const { data: { session } } = await db.auth.getSession();
        if (!session) return;
        const res = await fetch(`${BACKEND_URL}/api/partner/self/chips`, {
            headers: { Authorization: `Bearer ${session.access_token}` }
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok || !j.ok) {
            tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:#e085a0;">${escapeHtml(j.detail || j.error || res.statusText)}</td></tr>`;
            renderPartnerPolosKeysList([]);
            if (tableChips) tableChips.classList.remove('partner-chips-one-station');
            return;
        }
        const polosList = j.polos || [];
        const nStations = polosList.length;
        if (tableChips) tableChips.classList.toggle('partner-chips-one-station', nStations === 1);
        renderPartnerPolosKeysList(polosList);
        const rows = j.chips || [];
        if (rows.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;opacity:0.6;">Nenhum chip ainda. Quando o FluxSMS Desktop estiver a correr, os modems surgem aqui.</td></tr>';
            return;
        }
        tbody.innerHTML = rows.map((c) => {
            const wa = c.disponivel_em
                ? (new Date(c.disponivel_em) > new Date()
                    ? escapeHtml(new Date(c.disponivel_em).toLocaleString('pt-BR'))
                    : '—')
                : '—';
            const commLine = c.polo_ultima
                ? `${escapeHtml(c.polo_status || '—')} · ${escapeHtml(new Date(c.polo_ultima).toLocaleString('pt-BR'))}`
                : escapeHtml(c.polo_status || '—');
            return `<tr>
                <td class="partner-col-station">${escapeHtml(c.polo_nome || '—')}</td>
                <td><code>${escapeHtml(c.porta || '')}</code></td>
                <td>${escapeHtml(c.numero || '—')}</td>
                <td>${escapeHtml(c.status || '')}</td>
                <td style="font-size:0.75rem;">${commLine}</td>
                <td style="font-size:0.75rem;">${wa}</td>
            </tr>`;
        }).join('');
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:#e085a0;">${escapeHtml(e.message || String(e))}</td></tr>`;
    }
}

async function loadPartnerServiceToggles() {
    const wrap = document.getElementById('partner-services-toggles');
    const msg = document.getElementById('partner-services-msg');
    if (!wrap || !currentUserIsPartner || !db) return;
    wrap.innerHTML = '<div style="opacity:0.6;">Carregando serviços…</div>';
    if (msg) msg.textContent = '';
    try {
        const { data: { session } } = await db.auth.getSession();
        if (!session) return;
        const res = await fetch(`${BACKEND_URL}/api/partner/self/service-toggles`, {
            headers: { Authorization: `Bearer ${session.access_token}` }
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok || !j.ok) {
            wrap.innerHTML = `<div style="color:#e085a0;">${escapeHtml(j.detail || j.error || res.statusText)}</div>`;
            return;
        }
        const rows = j.services || [];
        if (!rows.length) {
            wrap.innerHTML = '<div style="opacity:0.65;">Nenhum serviço configurado.</div>';
            return;
        }
        wrap.innerHTML = rows.map((r) => {
            const service = String(r.service || '').toLowerCase();
            const checked = r.enabled !== false ? 'checked' : '';
            return `<label style="display:flex; align-items:center; gap:8px; background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.08); border-radius:8px; padding:10px;">
                <input type="checkbox" data-service-toggle="${escapeHtml(service)}" ${checked}>
                <span style="text-transform:capitalize;">${escapeHtml(service)}</span>
            </label>`;
        }).join('');
    } catch (e) {
        wrap.innerHTML = `<div style="color:#e085a0;">${escapeHtml(e.message || String(e))}</div>`;
    }
}

window.savePartnerServiceToggles = async function () {
    const checks = Array.from(document.querySelectorAll('[data-service-toggle]'));
    const msg = document.getElementById('partner-services-msg');
    if (!checks.length || !db) return;
    const services = checks.map((el) => ({
        service: String(el.getAttribute('data-service-toggle') || '').toLowerCase(),
        enabled: !!el.checked
    }));
    try {
        const { data: { session } } = await db.auth.getSession();
        if (!session) {
            if (msg) msg.textContent = 'Sessão expirada. Faça login novamente.';
            return;
        }
        const res = await fetch(`${BACKEND_URL}/api/partner/self/service-toggles`, {
            method: 'PUT',
            headers: {
                Authorization: `Bearer ${session.access_token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ services })
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok || !j.ok) {
            if (msg) msg.textContent = `Falha ao salvar: ${j.detail || j.error || res.statusText}`;
            return;
        }
        if (msg) msg.textContent = 'Serviços atualizados com sucesso.';
    } catch (e) {
        if (msg) msg.textContent = `Erro: ${e.message || e}`;
    }
};
let pixCheckInterval = null;

async function gerarPix() {
    const amount = parseFloat(document.getElementById('valorRecarga').value);
    try {
        const res = await fetch(`${BACKEND_URL}/webhook/criar-pix`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${(await db.auth.getSession()).data.session.access_token}`,
                'X-Idempotency-Key': Math.random().toString(36).substring(7)
            },
            body: JSON.stringify({ amount })
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error);

        document.getElementById('qrCodeContainer').innerHTML = `
            <div style="text-align:center">
                <img src="data:image/png;base64,${data.qr_code_b64}" style="width:200px;"><br>
                <div style="background:rgba(255,255,255,0.05); padding:10px; margin-top:10px; font-size:11px; word-break:break-all;">${data.qr_code}</div>
                <button onclick="navigator.clipboard.writeText('${data.qr_code}').then(()=>alert('Código PIX copiado com sucesso!'))" style="margin-top:10px; background:var(--flux-gold); width:100%; padding:10px; border-radius:8px; font-weight:bold;">COPIAR PIX</button>
            </div>
        `;
        document.getElementById('pixArea').style.display = 'block';
    } catch (err) {
        console.error("Erro PIX:", err);
        alert("Erro ao solicitar PIX: " + err.message);
    }
    const { data: profile } = await db.from('profiles').select('balance').eq('id', currentUser.id).single();
    initialBalance = profile?.balance || 0;
    if (pixCheckInterval) clearInterval(pixCheckInterval);
    pixCheckInterval = setInterval(checkBalanceAuto, 5000);
}

async function checkBalanceAuto() {
    if (!currentUser) return;
    const { data: profile } = await db.from('profiles').select('balance').eq('id', currentUser.id).single();
    if (profile && profile.balance > initialBalance) {
        if (pixCheckInterval) clearInterval(pixCheckInterval);
        await updateUIForUser();
        fecharRecarga();
        alert('Pagamento Recebido!');
    }
}

// === SERVIÇOS E ESTOQUE ===
async function fetchGlobalServices() {
    if (!db) return;
    const { data, error } = await db.from('services_config').select('*');
    if (!error && data) {
        const favoriteOrder = ['whatsapp', 'telegram', 'google', 'instagram'];
        SERVICES = data.sort((a, b) => {
            let indexA = favoriteOrder.indexOf(a.id);
            let indexB = favoriteOrder.indexOf(b.id);
            if (indexA === -1) indexA = 999;
            if (indexB === -1) indexB = 999;
            if (indexA !== indexB) return indexA - indexB;
            return a.name.localeCompare(b.name);
        });
        renderServices(SERVICES);
    }
}

async function loadChipsCount() {
    if (!db) return;

    // Busca chips (no lab, ignoramos a trava de 90s se for a estação de teste)
    const ninetySecondsAgo = new Date(Date.now() - 90000).toISOString();
    const isLab = window.location.hostname.includes('railway.app');

    let query = db.from('chips')
        .select('*, polos!inner(ultima_comunicacao)', { count: 'exact', head: true })
        .in('status', ['idle', 'quarentena'])
        .eq('polos.status', 'ONLINE')
        .not('numero', 'ilike', 'CCID%');

    if (!isLab) {
        query = query.gt('polos.ultima_comunicacao', ninetySecondsAgo);
    }

    const { count } = await query;

    chipsDisponiveis = count || 0;
    try {
        const { data: stocks } = await db.rpc('rpc_get_service_stocks');
        if (stocks) serviceStocks = stocks;
        renderServices(SERVICES);
    } catch (e) { console.error("Erro stocks:", e); }
    const stockEl = document.getElementById('stock-count');
    if (stockEl) stockEl.innerText = `${chipsDisponiveis} Chips Ativos ${isLab ? '(LAB)' : ''}`;
}

let chipsDebounce = null;
function setupRealtimeChips() {
    if (!db) return;
    db.channel('chips-realtime').on('postgres_changes', { event: '*', schema: 'public', table: 'chips' }, () => {
        if (chipsDebounce) clearTimeout(chipsDebounce);
        chipsDebounce = setTimeout(loadChipsCount, 800);
    }).subscribe();
}

let userDiscountFactor = 0;
let userFidelityLevel = 'Bronze';
let userSpentLast30Days = 0;
let userWhatsappLevel = WHATSAPP_LEVELS[0];

function getLaunchPromoEndDate() {
    const start = new Date(LAUNCH_PROMO_START_ISO);
    const end = new Date(start.getTime());
    end.setDate(end.getDate() + LAUNCH_PROMO_DAYS);
    return end;
}

function isLaunchPromoActive() {
    return new Date() < getLaunchPromoEndDate();
}

function getLaunchPromoDaysRemaining() {
    const diffMs = getLaunchPromoEndDate().getTime() - Date.now();
    if (diffMs <= 0) return 0;
    return Math.ceil(diffMs / (1000 * 60 * 60 * 24));
}

async function getUserSpentLast30Days() {
    if (!db || !currentUser) return 0;
    const thirtyDaysAgo = new Date(Date.now() - (30 * 24 * 60 * 60 * 1000)).toISOString();
    const { data, error } = await db
        .from('transactions')
        .select('amount')
        .eq('user_id', currentUser.id)
        .eq('type', 'debit')
        .gte('created_at', thirtyDaysAgo);
    if (error || !Array.isArray(data)) return 0;
    return data.reduce((sum, row) => sum + Math.abs(Number(row.amount || 0)), 0);
}

function resolveWhatsappLevel(spentLast30Days) {
    if (spentLast30Days > 3000) return WHATSAPP_LEVELS[3];
    if (spentLast30Days > 1000) return WHATSAPP_LEVELS[2];
    if (spentLast30Days > 200) return WHATSAPP_LEVELS[1];
    return WHATSAPP_LEVELS[0];
}

function getWhatsappBasePriceForCurrentUser() {
    if (isLaunchPromoActive()) return 6.10;
    return userWhatsappLevel.price;
}

function updateLaunchTimerBanner() {
    const banner = document.getElementById('launch-timer-banner');
    const card = document.getElementById('launch-timer-card');
    const daysEl = document.getElementById('launch-timer-days');
    if (!banner || !daysEl) return;
    const days = getLaunchPromoDaysRemaining();
    if (days > 0) {
        const suffix = days === 1 ? '1 dia' : `${days} dias`;
        daysEl.textContent = suffix;
        banner.style.display = 'block';
        if (card) card.style.display = 'block';
    } else {
        banner.style.display = 'none';
        if (card) card.style.display = 'none';
    }
}

function updateLevelProgressUI() {
    const card = document.getElementById('level-progress-card');
    const badge = document.getElementById('level-current-badge');
    const price = document.getElementById('level-current-price');
    const fill = document.getElementById('level-progress-fill');
    const text = document.getElementById('level-progress-text');
    if (!card || !badge || !price || !fill || !text) return;
    card.style.display = 'block';
    badge.textContent = userWhatsappLevel.label.toUpperCase();
    badge.className = `fidelity-badge ${userWhatsappLevel.badgeClass}`;
    price.textContent = `WhatsApp: R$ ${userWhatsappLevel.price.toFixed(2)}`;
    const nextLevel = WHATSAPP_LEVELS.find(level => level.minSpent > userSpentLast30Days);
    if (!nextLevel) {
        fill.style.width = '100%';
        text.textContent = 'Parabéns! Você já está no Nível Ouro e paga R$ 6,10.';
        return;
    }
    const currentMin = userWhatsappLevel.minSpent;
    const range = Math.max(1, nextLevel.minSpent - currentMin);
    const progress = Math.max(0, Math.min(100, ((userSpentLast30Days - currentMin) / range) * 100));
    const remaining = Math.max(0, nextLevel.minSpent - userSpentLast30Days);
    fill.style.width = `${progress}%`;
    text.textContent = `Gaste mais R$ ${remaining.toFixed(2)} para atingir o Nível ${nextLevel.label} e pagar R$ ${nextLevel.price.toFixed(2)}.`;
}

async function updateUIForUser() {
    if (!currentUser) return;
    const { data: profile } = await db.from('profiles').select('*').eq('id', currentUser.id).single();
    if (!profile) {
        currentUserIsAdmin = false;
        currentUserIsPartner = false;
        document.body.classList.remove('partner-mode');
        return;
    }

    currentUserIsAdmin = !!profile.is_admin;
    currentUserIsPartner = !!profile.is_partner;

    const operatorSelect = document.getElementById('operator-preference');
    if (operatorSelect) {
        operatorSelect.value = profile.preferred_operator || 'any';
    }

    if (IS_PARTNER_PORTAL && !currentUserIsPartner) {
        alert('Este portal é exclusivo para fornecedores com perfil parceiro activo.');
        await db.auth.signOut();
        window.location.replace(PARTNER_LOGIN_PATH);
        return;
    }

    if (!IS_PARTNER_PORTAL) {
        const b = `R$ ${profile.balance.toFixed(2)}`;
        if (document.getElementById('balance-display')) document.getElementById('balance-display').innerText = b;
        if (document.getElementById('balance-display-mobile')) document.getElementById('balance-display-mobile').innerText = b;
        updateLaunchTimerBanner();

        // --- FIDELIDADE INTELIGENTE ---
        const total = profile.total_recharged || 0;
        let pClass = 'badge-bronze';
        userFidelityLevel = 'BRONZE';
        userDiscountFactor = 0;

        if (total >= 5000) { userFidelityLevel = 'DIAMANTE'; userDiscountFactor = 0.40; pClass = 'badge-diamante'; }
        else if (total >= 1000) { userFidelityLevel = 'OURO'; userDiscountFactor = 0.25; pClass = 'badge-ouro'; }
        else if (total >= 200) { userFidelityLevel = 'PRATA'; userDiscountFactor = 0.10; pClass = 'badge-prata'; }

        const b1 = document.getElementById('fidelity-badge');
        const b2 = document.getElementById('fidelity-badge-mobile');
        if (b1) { b1.innerText = userFidelityLevel; b1.className = 'fidelity-badge ' + pClass; b1.style.display = 'inline-block'; }
        if (b2) { b2.innerText = userFidelityLevel; b2.className = 'fidelity-badge ' + pClass; b2.style.display = 'inline-block'; }
        userSpentLast30Days = await getUserSpentLast30Days();
        userWhatsappLevel = resolveWhatsappLevel(userSpentLast30Days);
        updateLevelProgressUI();
        // ------------------------------
    }

    const needsWhatsapp = !normalizeWhatsapp(profile.whatsapp || '');
    if (currentUser && needsWhatsapp && !profileCompletionShown) {
        profileCompletionShown = true;
        openProfileCompletionModal('');
    }

    if (document.getElementById('user-initials') && profile.full_name) {
        document.getElementById('user-initials').innerText = profile.full_name.split(' ').map(n => n[0]).join('').toUpperCase().substring(0, 2);
    }
    const partnerWrap = document.getElementById('partner-header-wrap');
    const navPartners = document.getElementById('nav-partners');
    const showPartnerUi = IS_PARTNER_PORTAL
        ? !!currentUserIsPartner
        : (!!profile.is_admin || PARTNER_UI_FORCE_VISIBLE || currentUserIsPartner);
    if (partnerWrap) partnerWrap.style.display = showPartnerUi ? 'inline-flex' : 'none';
    if (navPartners) navPartners.style.display = showPartnerUi ? 'flex' : 'none';

    if (profile.is_admin && !IS_PARTNER_PORTAL && !document.getElementById('btn-admin-link')) {
        const nav = document.querySelector('.main-nav');
        const a = document.createElement('a');
        a.id = 'btn-admin-link'; a.href = 'admindiretoria/index.html'; a.className = 'nav-item';
        a.style.color = 'var(--flux-gold)'; a.innerHTML = `⚙️ Painel Admin`;
        nav.insertBefore(a, nav.firstChild);
    }

    document.body.classList.toggle('partner-mode', !!currentUserIsPartner);

    const navDashLabel = document.getElementById('nav-dashboard-label');
    if (navDashLabel) navDashLabel.textContent = currentUserIsPartner ? 'Infraestrutura' : 'Dashboard';

    if (currentUserIsPartner) {
        loadPartnerAutonomyStrip();
    } else {
        const strip = document.getElementById('partner-autonomy-strip');
        if (strip) strip.style.display = 'none';
        _partnerBootstrapPartner = null;
    }

    syncPartnerPanelsVisibility();
    loadSecurityPanel();
}

function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function formatPartnerChipsCell(chips) {
    if (!chips || !chips.length) {
        return '<span style="opacity:0.45;font-size:0.78rem;">Sem chips nesta vista; contacte a equipa se precisar de ligação.</span>';
    }
    return chips.map((c) => {
        const label = c.numero || c.porta || c.id;
        const est = c.polo_nome ? ` <span style="opacity:0.5">(${escapeHtml(c.polo_nome)})</span>` : '';
        let wa = '';
        if (c.disponivel_em) {
            const until = new Date(c.disponivel_em);
            if (until > new Date()) {
                wa = ` <span class="partner-wa-lock">WA quarentena até ${until.toLocaleString('pt-BR')}</span>`;
            }
        }
        return `<div class="partner-chip-line"><strong>${escapeHtml(String(label))}</strong>${est} · R$ ${Number(c.revenue_total || 0).toFixed(2)} · <span style="opacity:0.75">${escapeHtml(c.status || '')}</span>${wa}</div>`;
    }).join('');
}

function updatePartnerWithdrawFeePreview(lastSummary) {
    const amtEl = document.getElementById('partner-withdraw-amount');
    const previewEl = document.getElementById('partner-withdraw-fee-preview');
    if (!previewEl) return;
    const fee = (lastSummary && lastSummary.rules && lastSummary.rules.withdrawal_fee_brl != null)
        ? Number(lastSummary.rules.withdrawal_fee_brl)
        : 5;
    const raw = amtEl && amtEl.value ? String(amtEl.value).replace(',', '.') : '';
    const v = parseFloat(raw);
    if (!Number.isFinite(v) || v <= 0) {
        previewEl.innerHTML = `Taxa de processamento: R$ ${fee.toFixed(2)} | Você receberá: <strong>—</strong>`;
        return;
    }
    const net = Math.max(0, Math.round((v - fee) * 100) / 100);
    previewEl.innerHTML = `Taxa de processamento: R$ ${fee.toFixed(2)} | Você receberá: <strong>R$ ${net.toFixed(2)}</strong>`;
}

function updatePartnerWithdrawButtonState(lastSummary) {
    const btn = document.getElementById('partner-withdraw-btn');
    const amtEl = document.getElementById('partner-withdraw-amount');
    if (!btn || !amtEl) return;
    const minBrl = (lastSummary && lastSummary.rules && lastSummary.rules.min_withdrawal_brl) ? lastSummary.rules.min_withdrawal_brl : 400;
    const maxBrl = (lastSummary && lastSummary.totals) ? Number(lastSummary.totals.disponivel_para_solicitar || 0) : 0;
    const fee = (lastSummary && lastSummary.rules && lastSummary.rules.withdrawal_fee_brl != null)
        ? Number(lastSummary.rules.withdrawal_fee_brl)
        : 5;
    const v = parseFloat(String(amtEl.value).replace(',', '.'));
    const ok = Number.isFinite(v) && v > fee && v >= minBrl && v <= maxBrl + 0.009 && maxBrl >= minBrl;
    btn.disabled = !ok;
    btn.style.opacity = ok ? '1' : '0.45';
    updatePartnerWithdrawFeePreview(lastSummary);
}

let _partnerFinanceSummaryCache = null;

async function loadPartnerFinanceSummary() {
    const rulesEl = document.getElementById('partner-finance-rules');
    const statsEl = document.getElementById('partner-finance-stats');
    const msgEl = document.getElementById('partner-finance-msg');
    if (!currentUserIsPartner || !rulesEl || !statsEl) return;

    const { data: { session } } = await db.auth.getSession();
    if (!session) {
        rulesEl.innerHTML = '<p style="color:#e085a0;">Faça login novamente.</p>';
        return;
    }

    rulesEl.innerHTML = '<p style="opacity:0.6;">Carregando regras e saldos…</p>';
    statsEl.innerHTML = '';

    try {
        const res = await fetch(`${BACKEND_URL}/api/partner/finance/summary`, {
            headers: { Authorization: `Bearer ${session.access_token}` }
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok || !j.ok) {
            rulesEl.innerHTML = `<p style="color:#e085a0;">${escapeHtml(j.detail || j.error || res.statusText)}</p>`;
            return;
        }
        _partnerFinanceSummaryCache = j;
        const r = j.rules || {};
        const t = j.totals || {};
        const repassePct = Number(r.repasse_percent || 60);
        _partnerMarginPercent = repassePct;
        const feeBrl = r.withdrawal_fee_brl != null ? Number(r.withdrawal_fee_brl) : 5;
        const prazoLabel = r.is_novo_parceiro
            ? `Parceiro <strong>novo</strong> (menos de ${r.novo_period_days || 90} dias no programa): cada repasse só entra no saque após <strong>${r.hold_hours_novo || 48}h</strong> da data do SMS recebido.`
            : `Parceiro <strong>consolidado</strong>: carência de <strong>${r.hold_hours_antigo || 24}h</strong> após cada SMS recebido.`;

        rulesEl.innerHTML = `
            <ul style="margin:0; padding-left:18px; line-height:1.55; font-size:0.88rem; color:rgba(255,255,255,0.88);">
                <li><strong>Repasse comercial:</strong> ${repassePct}% sobre o valor de cada SMS recebido nos seus chips.</li>
                <li><strong>Mínimo para saque:</strong> R$ ${(r.min_withdrawal_brl || 400).toFixed(2)} — valores menores não podem ser solicitados.</li>
                <li><strong>Prazos (carência sobre o repasse):</strong> ${prazoLabel}</li>
                <li><strong>Taxa de processamento por saque:</strong> R$ ${feeBrl.toFixed(2)} por solicitação (descontada do valor pedido; o pagamento é do <strong>valor líquido</strong>).</li>
            </ul>`;

        const stat = (label, val, color) => `
            <div style="padding:12px; border-radius:10px; background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.08);">
                <div style="font-size:10px; opacity:0.55; text-transform:uppercase;">${label}</div>
                <div style="font-size:1.05rem; font-weight:800; color:${color}; margin-top:4px;">${val}</div>
            </div>`;
        statsEl.innerHTML =
            stat('Repasse total (acumulado)', `R$ ${Number(t.repasse_total || 0).toFixed(2)}`, '#d4b8ff') +
            stat('Já liberado para saque', `R$ ${Number(t.repasse_liberado || 0).toFixed(2)}`, '#b8f5c8') +
            stat('Ainda em carência', `R$ ${Number(t.repasse_em_carencia || 0).toFixed(2)}`, '#ffd59a') +
            stat('Reservado (saques em análise)', `R$ ${Number(t.saques_pendentes_ou_aprovados || 0).toFixed(2)}`, '#ccc') +
            stat('Disponível p/ solicitar agora', `R$ ${Number(t.disponivel_para_solicitar || 0).toFixed(2)}`, 'var(--flux-gold)');

        if (msgEl) {
            msgEl.innerHTML = 'O botão de saque só habilita quando o valor estiver entre o <strong>mínimo</strong> e o <strong>disponível para solicitar</strong>, e for <strong>maior que a taxa de processamento</strong>. Pedidos ficam como pendentes até o financeiro FluxSMS.';
        }
        updatePartnerWithdrawButtonState(j);
        updatePartnerWithdrawFeePreview(j);
    } catch (e) {
        rulesEl.innerHTML = `<p style="color:#e085a0;">${escapeHtml(e.message || String(e))}</p>`;
    }
}

window.submitPartnerWithdraw = async function () {
    if (!currentUserIsPartner) return;
    const amtEl = document.getElementById('partner-withdraw-amount');
    const pixEl = document.getElementById('partner-withdraw-pix');
    const msgEl = document.getElementById('partner-finance-msg');
    const raw = amtEl && amtEl.value ? String(amtEl.value).replace(',', '.') : '';
    const amount = parseFloat(raw);
    const pix = pixEl && pixEl.value ? pixEl.value.trim() : '';

    const { data: { session } } = await db.auth.getSession();
    if (!session) {
        alert('Faça login novamente.');
        return;
    }
    try {
        const res = await fetch(`${BACKEND_URL}/api/partner/finance/withdraw`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${session.access_token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ amount, pix_destination: pix || null })
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok || !j.ok) {
            const extra = j.disponivel_para_solicitar != null ? ` Disponível: R$ ${Number(j.disponivel_para_solicitar).toFixed(2)}.` : '';
            const min = j.min_brl != null ? ` Mínimo: R$ ${Number(j.min_brl).toFixed(2)}.` : '';
            alert('Não foi possível registrar o saque: ' + (j.detail || j.error || res.statusText) + min + extra);
            return;
        }
        if (msgEl) {
            const w = j.withdrawal || {};
            const gross = w.amount != null ? Number(w.amount) : amount;
            const fee = w.fee_brl != null ? Number(w.fee_brl) : 5;
            const net = w.net_amount != null ? Number(w.net_amount) : Math.max(0, Math.round((gross - fee) * 100) / 100);
            msgEl.textContent = `Pedido registado. Bruto: R$ ${gross.toFixed(2)} · Taxa: R$ ${fee.toFixed(2)} · Você receberá: R$ ${net.toFixed(2)} (após validação).`;
        }
        if (amtEl) amtEl.value = '';
        await loadPartnerFinanceSummary();
        loadPartnerAutonomyStrip();
    } catch (e) {
        alert('Falha: ' + (e.message || e));
    }
};

async function loadPartnerProfiles() {
    syncPartnerPanelsVisibility();

    if (currentUserIsPartner) {
        await loadPartnerFinanceSummary();
        loadPartnerAutonomyStrip();
        loadPartnerServiceToggles();
    }

    const tbody = document.querySelector('#table-partners tbody');
    const colspan = 11;
    if (!tbody) return;

    if (!currentUserIsAdmin) {
        tbody.innerHTML = `<tr><td colspan="${colspan}" style="text-align:center; opacity:0.55;">Lista administrativa de parceiros visível apenas para administradores.</td></tr>`;
        return;
    }

    if (!db) {
        tbody.innerHTML = `<tr><td colspan="${colspan}" style="text-align:center;">Supabase indisponível.</td></tr>`;
        return;
    }

    tbody.innerHTML = `<tr><td colspan="${colspan}" style="text-align:center;">Carregando parceiros...</td></tr>`;

    const { data: { session } } = await db.auth.getSession();
    if (!session) {
        tbody.innerHTML = `<tr><td colspan="${colspan}" style="text-align:center;">Faça login novamente.</td></tr>`;
        return;
    }

    try {
        const res = await fetch(`${BACKEND_URL}/api/admin/partners`, {
            headers: { Authorization: `Bearer ${session.access_token}` }
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || !json.ok) {
            const msg = json.error === 'forbidden' ? 'Acesso negado (apenas admin).' : (json.detail || json.error || res.statusText);
            throw new Error(msg);
        }
        const rows = json.partners || [];
        if (rows.length === 0) {
            tbody.innerHTML = `<tr><td colspan="${colspan}" style="text-align:center;">Nenhum parceiro cadastrado em <code>partner_profiles</code>.</td></tr>`;
            return;
        }
        tbody.innerHTML = rows.map((p) => {
            const pr = p.profile || {};
            const email = pr.email || '—';
            const name = pr.full_name || '—';
            const bal = pr.balance != null ? `R$ ${Number(pr.balance).toFixed(2)}` : '—';
            const created = p.created_at ? new Date(p.created_at).toLocaleString('pt-BR') : '—';
            const nChips = p.chip_count != null ? p.chip_count : (p.chips || []).length;
            const rev = p.revenue_total != null ? Number(p.revenue_total).toFixed(2) : '0.00';
            const keyCell = '<span style="opacity:0.55;font-size:10px;">Chave única no cadastro</span>';
            return `
        <tr>
            <td><code>${escapeHtml(p.partner_code)}</code></td>
            <td>${escapeHtml(email)}</td>
            <td>${escapeHtml(name)}</td>
            <td style="color:#d4b8ff;font-weight:700;">${escapeHtml(bal)}</td>
            <td><span class="partner-status-badge partner-status-${escapeHtml((p.status || '').toLowerCase())}">${escapeHtml(p.status || '—')}</span></td>
            <td>${Number(p.margin_percent || 0).toFixed(2)}%</td>
            <td style="text-align:center;">${nChips}</td>
            <td style="color:#b8f5c8;font-weight:700;">R$ ${escapeHtml(rev)}</td>
            <td style="font-size:0.72rem;line-height:1.35;">${formatPartnerChipsCell(p.chips)}</td>
            <td style="font-size:0.8rem;color:rgba(255,255,255,0.45);">${created}</td>
            <td style="text-align:center;">${keyCell}</td>
        </tr>`;
        }).join('');
    } catch (err) {
        tbody.innerHTML = `<tr><td colspan="${colspan}" style="text-align:center;color:#e085a0;">${escapeHtml(err.message || String(err))}</td></tr>`;
    }
}

window.loadPartnerProfiles = loadPartnerProfiles;

async function fetchUserCustomPrices() {
    if (!db || !currentUser || currentUserIsPartner) return;
    const { data } = await db.from('custom_prices').select('service, price').eq('user_id', currentUser.id);
    if (data) {
        userCustomPrices = {};
        data.forEach(cp => { userCustomPrices[cp.service] = cp.price; });
        renderServices(SERVICES);
    }
}

function renderServices(list) {
    if (!servicesGrid) return;
    servicesGrid.innerHTML = list.map(s => {
        const stock = serviceStocks[s.id] ?? (chipsDisponiveis > 0 ? 1 : 0);
        let finalPrice = userCustomPrices[s.id] || s.price;
        if (s.id === 'whatsapp') {
            finalPrice = getWhatsappBasePriceForCurrentUser();
        }
        
        let priceHtml = `R$ ${finalPrice.toFixed(2)}`;
        if (userDiscountFactor > 0) {
            const discounted = finalPrice * (1.0 - userDiscountFactor);
            priceHtml = `<span class="discount-strike">R$ ${finalPrice.toFixed(2)}</span><span class="discount-final">R$ ${discounted.toFixed(2)}</span><span class="discount-level">(${userFidelityLevel})</span>`;
        }
        
        return `
            <div class="service-row">
                <div class="name">${s.name}</div>
                <div class="price">${priceHtml}</div>
                <div class="action">
                    <button class="btn-buy" onclick="requestNumber('${s.id}', '${s.name}', ${finalPrice.toFixed(2)})" ${stock <= 0 ? 'disabled' : ''}>
                        ${stock <= 0 ? 'SEM ESTOQUE' : 'SOLICITAR'}
                    </button>
                </div>
            </div>
        `;
    }).join('');
}

// === ACTIVATIONS ===
async function requestNumber(serviceId, serviceName, defaultPrice) {
    // TRAVA 1: Máximo 5 ativações simultâneas
    const { count } = await db.from('activations')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', currentUser.id)
        .eq('status', 'waiting');
    if (count >= 5) {
        alert('⚠️ Você atingiu o limite de 5 pedidos simultâneos.\nFinalize ou cancele um para pedir outro.');
        return;
    }

    // Usa a V3 blindada com sistema fiel de Descontos e Acúmulos
    const { data, error } = await db.rpc('rpc_solicitar_sms_v3', {
        p_user_id: currentUser.id,
        p_service: serviceId,
        p_service_name: serviceName,
        p_default_price: defaultPrice
    });

    if (error || !data || !data.ok) {
        console.error("ERRO CRÍTICO RPC:", { error, data });

        // 🛡️ CAPTURA DE "Unexpected token <": Se o erro for HTML em vez de JSON
        if (error && typeof error === 'string' && error.startsWith('<!DOCTYPE')) {
            alert('ERRO DE SERVIDOR (HTML): O banco de dados retornou uma página de erro. Me avise para eu verificar os logs da Railway.');
            return;
        }

        const errorMsg = error?.message || data?.error || "Sem estoque ou falha na conexão.";
        alert('Erro ao solicitar: ' + (errorMsg !== 'undefined' ? errorMsg : 'Falha desconhecida. Tente novamente.'));
        return;
    }

    renderActivationCard({
        id: data.activation_id,
        phone_number: data.numero,
        service_name: serviceName,
        status: 'waiting',
        sms_code: null,
        created_at: new Date().toISOString()
    });
    updateUIForUser();
}

function renderActivationCard(act) {
    if (document.getElementById(act.id)) return;
    if (activeNumbers.querySelector('.empty-state')) activeNumbers.innerHTML = '';

    const displayCode = unscrambleSMS(act.sms_code);

    const createdAt = act.created_at ? new Date(act.created_at).getTime() : Date.now();

    const h = `
        <div class="session-card" id="${act.id}">
            <span class="number">${act.phone_number}</span>
            <div class="specialist-tip">
                <b>💡 Dica de Especialista:</b>
                Para melhor desempenho, use conexão 4G/5G e ative/desative o modo avião antes de cada nova ativação. Isso preserva a qualidade e aumenta a durabilidade do seu WhatsApp!
            </div>
            <span class="status" id="status-${act.id}">${act.status === 'received' ? 'RECEBIDO' : 'Aguardando...'}</span>
            <div style="font-size:10px;">${act.service_name}</div>
            <div class="sms-code-display" id="code-${act.id}">${displayCode || '------'}</div>
            <div id="actions-${act.id}">${act.status === 'waiting' ? `<button id="btn-cancel-${act.id}" class="btn-cancel" onclick="cancelActivation('${act.id}')">CANCELAR</button>` : '✓'}</div>
        </div>
    `;
    activeNumbers.insertAdjacentHTML('afterbegin', h);

    if (act.status === 'waiting') {
        // TRAVA 3: Auto-cancelamento após 10 minutos
        const TIMEOUT_MS = 10 * 60 * 1000; // 10 minutos
        const msSinceCreated = Date.now() - createdAt;
        const timeoutRemaining = Math.max(0, TIMEOUT_MS - msSinceCreated);
        setTimeout(async () => {
            const card = document.getElementById(act.id);
            const statusEl = document.getElementById(`status-${act.id}`);
            if (card && statusEl && statusEl.innerText !== 'RECEBIDO') {
                console.log(`[AUTO-CANCEL] Ativação ${act.id} expirou após 10 minutos.`);
                await cancelActivation(act.id);
            }
        }, timeoutRemaining);
    }
}

async function cancelActivation(id) {
    const card = document.getElementById(id);
    if (!card || !currentUser) return;
    card.remove();
    const { data, error } = await db.rpc('rpc_cancelar_ativacao', { p_user_id: currentUser.id, p_activation_id: id });
    if (error || !data?.ok) {
        activeNumbers.insertAdjacentHTML('afterbegin', '<div class="empty-state">Falha ao cancelar. Atualize e tente novamente.</div>');
    }
    updateUIForUser();
}
window.cancelActivation = cancelActivation;

async function loadActiveSessions() {
    if (!db || !currentUser || currentUserIsPartner) return;
    const { data } = await db.from('activations').select('*').eq('user_id', currentUser.id).in('status', ['waiting', 'received']);
    if (data && data.length > 0) {
        activeNumbers.innerHTML = '';
        data.filter(a => a.status === 'waiting' || (new Date() - new Date(a.updated_at)) < 120000).forEach(renderActivationCard);
    }
}

function setupRealtime() {
    if (isRealtimeActive || currentUserIsPartner) return;
    isRealtimeActive = true;
    db.channel('my-activations').on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'activations' }, payload => {
        const a = payload.new;
        if (a.user_id !== currentUser.id) return;
        if (a.status === 'received') updateCardWithSMS(a.id, a.sms_code);
        else if (['cancelled', 'expired'].includes(a.status)) document.getElementById(a.id)?.remove();
    }).subscribe();
    db.channel('my-profile').on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'profiles' }, updateUIForUser).subscribe();
}

function updateCardWithSMS(id, code) {
    const el = document.getElementById(`code-${id}`);
    if (el) {
        el.innerText = unscrambleSMS(code);
        document.getElementById(`status-${id}`).innerText = 'RECEBIDO';

        // Proteção: Remove do DOM e limpa vestígios após 2 min
        setTimeout(() => {
            const card = document.getElementById(id);
            if (card) {
                card.style.opacity = '0';
                setTimeout(() => {
                    card.remove();
                    console.log(`[SEC] Ativação ${id} purgada da memória e do DOM.`);
                }, 1000);
            }
        }, 120000);
    }
}

window.abrirRecarga = () => {
    if (IS_PARTNER_PORTAL) return;
    const m = document.getElementById('modalRecarga');
    if (m) m.style.display = 'flex';
};
window.fecharRecarga = () => { document.getElementById('modalRecarga').style.display = 'none'; clearInterval(pixCheckInterval); };

init();
