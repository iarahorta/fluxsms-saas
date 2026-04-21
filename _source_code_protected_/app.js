/**
 * FluxSMS - Frontend Business Logic (Realtime & Supabase Integration)
 */

// === SUPABASE CLIENT ===
const SUPABASE_URL = 'https://ewwhywbwtqwtuujemtfk.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV3d2h5d2J3dHF3dHV1amVtdGZrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYwOTAzMjYsImV4cCI6MjA5MTY2NjMyNn0.pgv9mkWHlq6wam7-BrN-zmlNDgyf-sDFTc1KT8IjvuU';

let db = null;
let currentUser = null;

db = window.supabase?.createClient(SUPABASE_URL, SUPABASE_ANON);

// === LISTA DE SERVIÇOS ===
let SERVICES = [
    { id: 'whatsapp', name: 'WhatsApp', price: 6.10 },
    { id: 'telegram', name: 'Telegram', price: 4.00 },
    { id: 'google', name: 'Google', price: 1.50 },
    { id: 'instagram', name: 'Instagram', price: 2.00 }
];
let userCustomPrices = {}; 

// === ESTADO GLOBAL ===
let activeSessions = {};
let chipsDisponiveis = 0;
let serviceStocks = {};
let isRealtimeActive = false;

// === ELEMENTOS ===
const landingView = document.getElementById('landing-view');
const dashboardView = document.getElementById('dashboard-view');
const authModal = document.getElementById('authModal');
const servicesGrid = document.getElementById('services-grid');
const activeNumbers = document.getElementById('active-numbers');
const searchInput = document.getElementById('service-search');

function unscrambleSMS(text) {
    try {
        if (!text || text === '------') return text;
        // Base64 Decode -> Invert
        const decoded = atob(text);
        return decoded.split('').reverse().join('');
    } catch(e) { return text; }
}

// === INICIALIZAÇÃO ===
async function init() {
    if (!db) {
        console.warn('Supabase não configurado.');
        renderServices(SERVICES);
        return;
    }

    const { data: { session } } = await db.auth.getSession();
    toggleViews(session);
    
    fetchGlobalServices().catch(e => console.log("Erro ao carregar preços"));
    setupRealtimeChips();

    if (session) {
        currentUser = session.user;
        updateUIForUser();
        await fetchUserCustomPrices();
        loadActiveSessions();
    }

    loadChipsCount();
    renderServices(SERVICES);

    searchInput.addEventListener('input', () => {
        const q = searchInput.value.toLowerCase();
        const filtered = SERVICES.filter(s => s.name.toLowerCase().includes(q));
        renderServices(filtered);
    });

    db.auth.onAuthStateChange((event, session) => {
        if (event === 'SIGNED_IN') {
            currentUser = session?.user;
            authModal.style.display = 'none';
            toggleViews(session);
            if (session) {
                updateUIForUser();
                loadActiveSessions();
                setupRealtime();
            }
        } else if (event === 'SIGNED_OUT') {
            currentUser = null;
            toggleViews(null);
            if (landingView.style.display === 'none') {
                window.location.reload();
            }
        }
    });
}

function toggleViews(session) {
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
window.showView = function(viewName) {
    console.log("Exibindo view:", viewName);
    
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
}

async function loadMyNumbers() {
    const tbody = document.querySelector('#table-my-numbers tbody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;">Carregando histórico...</td></tr>';

    const { data, error } = await db.from('activations').select('*').eq('user_id', currentUser.id).eq('status', 'received').order('created_at', { ascending: false });

    if (error || !data) {
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
            if (!email || !password || !name) { alert("Preencha todos os campos."); return; }
            const { data, error } = await db.auth.signUp({ email, password, options: { data: { full_name: name } } });
            if (error) { alert('Erro: ' + error.message); return; }
            if (!data.session) await db.auth.signInWithPassword({ email, password });
        }
    } catch (err) { console.error("Erro no handleAuth:", err); }
}

async function handleLogout() {
    await db.auth.signOut();
}

// === PIX ===
const BACKEND_URL = 'https://api.fluxsms.com.br';
let initialBalance = 0;
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
        if (err.message.includes('fetch')) {
            alert("ERRO DE DOMÍNIO: O servidor Railway ainda não autorizou o domínio fluxsms.com.br. Por favor, me avise para eu te dar o comando de liberação.");
        } else {
            alert("Erro ao gerar PIX: " + err.message);
        }
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
    
    // 🧹 GATILHO DO GARI: Monitora Polos e estorna saldo se houver queda (Distributed Cron)
    db.rpc('rpc_monitorar_e_estornar_v2').catch(e => console.error("Monitoramento Sync:", e));

    // Busca apenas chips de Polos que estão ONLINE e enviaram sinal nos últimos 90 segundos
    const ninetySecondsAgo = new Date(Date.now() - 90000).toISOString();
    const { count } = await db.from('chips')
        .select('*, polos!inner(ultima_comunicacao)', { count: 'exact', head: true })
        .eq('status', 'idle')
        .eq('polos.status', 'ONLINE')
        .gt('polos.ultima_comunicacao', ninetySecondsAgo)
        .not('numero', 'ilike', 'CCID%'); // 🛡️ FILTRO: Nada de CCID no estoque

    chipsDisponiveis = count || 0; 
    db.rpc('rpc_get_service_stocks').then(r => { 
        if(r.data) serviceStocks = r.data; 
        renderServices(SERVICES); 
    });
    const stockEl = document.getElementById('stock-count');
    if (stockEl) stockEl.innerText = `${chipsDisponiveis} Chips Ativos`;
}

function setupRealtimeChips() {
    if (!db) return;
    db.channel('chips-realtime').on('postgres_changes', { event: '*', schema: 'public', table: 'chips' }, loadChipsCount).subscribe();
}

async function updateUIForUser() {
    if (!currentUser) return;
    const { data: profile } = await db.from('profiles').select('*').eq('id', currentUser.id).single();
    if (profile) {
        const b = `R$ ${profile.balance.toFixed(2)}`;
        if (document.getElementById('balance-display')) document.getElementById('balance-display').innerText = b;
        if (document.getElementById('user-initials') && profile.full_name) {
            document.getElementById('user-initials').innerText = profile.full_name.split(' ').map(n => n[0]).join('').toUpperCase().substring(0, 2);
        }
        if (profile.is_admin && !document.getElementById('btn-admin-link')) {
            const nav = document.querySelector('.main-nav');
            const a = document.createElement('a');
            a.id = 'btn-admin-link'; a.href = 'admindiretoria/index.html'; a.className = 'nav-item';
            a.style.color = 'var(--flux-gold)'; a.innerHTML = `⚙️ Painel Admin`;
            nav.insertBefore(a, nav.firstChild);
        }
    }
}

async function fetchUserCustomPrices() {
    if (!db || !currentUser) return;
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
        const finalPrice = userCustomPrices[s.id] || s.price;
        return `
            <div class="service-row">
                <div class="name">${s.name}</div>
                <div class="price">R$ ${finalPrice.toFixed(2)}</div>
                <div class="action">
                    <button class="btn-buy" onclick="requestNumber('${s.id}', '${s.name}', ${finalPrice})" ${stock <= 0 ? 'disabled' : ''}>
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

    const { data, error } = await db.rpc('rpc_solicitar_sms_v2', { p_user_id: currentUser.id, p_service: serviceId, p_service_name: serviceName, p_default_price: defaultPrice });
    
    if (error || !data || !data.success) { 
        console.error("Erro RPC:", error, data);
        const errorMsg = error?.message || data?.error || "Nenhum chip disponível no momento ou falha na conexão.";
        alert('Erro ao solicitar: ' + errorMsg); 
        return; 
    }
    
    renderActivationCard({ 
        id: data.activation_id, 
        phone_number: data.phone_number, 
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

    // TRAVA 2: Botão CANCELAR bloqueado por 2 minutos
    const createdAt = act.created_at ? new Date(act.created_at).getTime() : Date.now();
    const LOCK_MS = 2 * 60 * 1000; // 2 minutos
    const msUntilUnlock = Math.max(0, (createdAt + LOCK_MS) - Date.now());
    const cancelDisabled = msUntilUnlock > 0 ? 'disabled class="btn-waiting"' : ''; // 🛡️ Removido style inline
    const cancelLabel = msUntilUnlock > 0 ? 'AGUARDE (2min)' : 'CANCELAR';

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
            <div id="actions-${act.id}">${act.status === 'waiting' ? `<button id="btn-cancel-${act.id}" onclick="cancelActivation('${act.id}')" ${cancelDisabled}>${cancelLabel}</button>` : '✓'}</div>
        </div>
    `;
    activeNumbers.insertAdjacentHTML('afterbegin', h);

    if (act.status === 'waiting') {
        // Desbloqueia o botão cancelar após o período de lock
        if (msUntilUnlock > 0) {
            setTimeout(() => {
                const btn = document.getElementById(`btn-cancel-${act.id}`);
                if (btn) { btn.disabled = false; btn.removeAttribute('style'); btn.innerText = 'CANCELAR'; }
            }, msUntilUnlock);
        }

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
    const { data } = await db.rpc('rpc_cancelar_ativacao', { p_user_id: currentUser.id, p_activation_id: id });
    if (data?.ok) { document.getElementById(id).remove(); updateUIForUser(); }
}

async function loadActiveSessions() {
    const { data } = await db.from('activations').select('*').eq('user_id', currentUser.id).in('status', ['waiting', 'received']);
    if (data && data.length > 0) {
        activeNumbers.innerHTML = '';
        data.filter(a => a.status === 'waiting' || (new Date() - new Date(a.updated_at)) < 120000).forEach(renderActivationCard);
    }
}

function setupRealtime() {
    if (isRealtimeActive) return;
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

window.abrirRecarga = () => { document.getElementById('modalRecarga').style.display = 'flex'; };
window.fecharRecarga = () => { document.getElementById('modalRecarga').style.display = 'none'; clearInterval(pixCheckInterval); };

init();
