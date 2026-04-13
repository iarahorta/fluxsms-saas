/**
 * FluxSMS - Frontend Business Logic (Realtime & Supabase Integration)
 */

// === SUPABASE CLIENT ===
// Em produção: __SUPABASE_URL__ e __SUPABASE_ANON_KEY__ são substituídos pelo GitHub Actions
const SUPABASE_URL  = '__SUPABASE_URL__';
const SUPABASE_ANON = '__SUPABASE_ANON_KEY__';

let supabase = null;
let currentUser = null;

// Inicializa Supabase
if (!SUPABASE_URL.includes('__') && !SUPABASE_ANON.includes('__')) {
    supabase = window.supabase?.createClient(SUPABASE_URL, SUPABASE_ANON);
}

// === LISTA DE SERVIÇOS (Tabela Padrão) ===
const SERVICES = [
    { id: 'whatsapp',    name: 'WhatsApp',      price: 6.10 },
    { id: 'telegram',    name: 'Telegram',      price: 4.00 },
    { id: 'google',      name: 'Google',        price: 1.50 },
    { id: 'uber',        name: 'Uber',          price: 1.20 },
    { id: 'tinder',      name: 'Tinder',        price: 4.50 },
    { id: 'gov',         name: 'GOV.BR',        price: 5.00 },
    { id: 'ifood',       name: 'iFood',         price: 0.90 },
    { id: 'instagram',   name: 'Instagram',     price: 2.00 },
    { id: 'tiktok',      name: 'TikTok',        price: 1.50 },
    { id: 'apple',       name: 'Apple ID',      price: 3.00 },
    { id: 'shopee',      name: 'Shopee',        price: 0.80 },
    { id: 'mercadolivre',name: 'Mercado Livre', price: 1.20 },
    { id: 'nubank',      name: 'Nubank',        price: 2.50 },
    { id: 'twitter',     name: 'X (Twitter)',   price: 1.00 },
    { id: 'paypal',      name: 'PayPal',        price: 2.00 }
];

// === ESTADO GLOBAL ===
let activeSessions = {}; // { activation_id: { ...data } }
let chipsDisponiveis = 0;

const servicesGrid = document.getElementById('services-grid');
const activeNumbers = document.getElementById('active-numbers');
const searchInput   = document.getElementById('service-search');

// === INICIALIZAÇÃO ===
async function init() {
    if (!supabase) {
        console.warn('Supabase não configurado. Rodando em modo simulação.');
        renderServices(SERVICES);
        return;
    }

    // 1. Verifica Sessão
    const { data: { session } } = await supabase.auth.getSession();
    if (session) {
        currentUser = session.user;
        updateUIForUser();
        loadActiveSessions();
        setupRealtime();
    } else {
        // Redireciona para login ou mostra modal (em um app real)
        console.log('Usuário deslogado. Mostrando serviços padrão.');
    }

    // 2. Carrega disponibilidade de chips
    loadChipsCount();

    // 3. Renderiza
    renderServices(SERVICES);
    document.getElementById('services-count').innerText = `${SERVICES.length} Serviços`;
    
    // 4. Listeners
    searchInput.addEventListener('input', () => {
        const q = searchInput.value.toLowerCase();
        const filtered = SERVICES.filter(s => s.name.toLowerCase().includes(q));
        renderServices(filtered);
    });

    // 5. Verifica evento de login bem-sucedido
    supabase.auth.onAuthStateChange((event, session) => {
        if (event === 'SIGNED_IN') {
            currentUser = session.user;
            document.getElementById('authModal').style.display = 'none';
            updateUIForUser();
            loadActiveSessions();
            setupRealtime();
        } else if (event === 'SIGNED_OUT') {
            window.location.reload();
        }
    });
}

// === AUTHENTICATION ===
async function handleAuth(type) {
    if (type === 'login') {
        const email = document.getElementById('auth-email').value;
        const password = document.getElementById('auth-password').value;
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) alert('Erro no login: ' + error.message);
    } else {
        const email = document.getElementById('reg-email').value;
        const password = document.getElementById('reg-password').value;
        const name = document.getElementById('reg-name').value;
        const { error } = await supabase.auth.signUp({ 
            email, 
            password,
            options: { data: { full_name: name } }
        });
        if (error) alert('Erro no cadastro: ' + error.message);
        else alert('Verifique seu e-mail para confirmar o cadastro!');
    }
}

async function logout() {
    await supabase.auth.signOut();
}

// === PIX RECHARGE ===
async function gerarPix() {
    const amount = parseFloat(document.getElementById('valorRecarga').value);
    if (!amount || amount < 5) { alert('Valor mínimo: R$ 5,00'); return; }

    const { data: { session } } = await supabase.auth.getSession();
    
    try {
        const res = await fetch(`${window.location.origin}/webhook/criar-pix`, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${session.access_token}`
            },
            body: JSON.stringify({ amount })
        });

        const data = await res.json();
        if (!data.ok) throw new Error(data.error);

        // Exibe QR Code (Base64 vindo do backend)
        const qrContent = document.getElementById('qrCodeContainer');
        qrContent.innerHTML = `<img src="data:image/png;base64,${data.qr_code_b64}" style="width: 200px;">`;
        document.getElementById('pixArea').style.display = 'block';

    } catch (err) {
        alert('Erro ao gerar Pix: ' + err.message);
    }
}

async function loadChipsCount() {
    const { count } = await supabase.from('chips').select('*', { count: 'exact', head: true }).eq('status', 'idle');
    chipsDisponiveis = count || 0;
    renderServices(SERVICES);
}

async function updateUIForUser() {
    if (!currentUser) return;

    // Atualiza saldo real do profiles
    const { data: profile } = await supabase.from('profiles').select('*').eq('id', currentUser.id).single();
    if (profile) {
        document.getElementById('user-balance').innerText = `R$ ${profile.balance.toFixed(2)}`;
        
        // Se for admin, mostra link do painel no menu (mock por enquanto, o ideal é injetar no DOM)
        if (profile.is_admin && !document.getElementById('btn-admin-link')) {
             const sidebar = document.querySelector('.sb-menu');
             const adminLink = document.createElement('a');
             adminLink.id = 'btn-admin-link';
             adminLink.href = 'admin.html';
             adminLink.className = 'menu-item';
             adminLink.style.color = '#D4AF37';
             adminLink.innerHTML = `<span class="icon">⚙️</span> Painel Admin`;
             sidebar.appendChild(adminLink);
        }
    }
}

function renderServices(list) {
    const sem_estoque = chipsDisponiveis <= 0;
    servicesGrid.innerHTML = list.map(s => `
        <div class="service-row">
            <div class="name">${s.name}</div>
            <div class="price">R$ ${s.price.toFixed(2)}</div>
            <div class="action">
                <button class="btn-buy" 
                        onclick="requestNumber('${s.id}', '${s.name}', ${s.price})"
                        ${sem_estoque ? 'disabled' : ''}>
                    ${sem_estoque ? 'SEM ESTOQUE' : 'SOLICITAR'}
                </button>
            </div>
        </div>
    `).join('');
}

// === SOLICITAR NÚMERO (REAL) ===
async function requestNumber(serviceId, serviceName, defaultPrice) {
    if (!currentUser) {
        alert('Faça login para solicitar números.');
        return;
    }

    // Chama a RPC V2 (que lida com preços customizados e saldos)
    const { data, error } = await supabase.rpc('rpc_solicitar_sms_v2', {
        p_user_id:       currentUser.id,
        p_service:       serviceId,
        p_service_name:  serviceName,
        p_default_price: defaultPrice
    });

    if (error) {
        alert('Erro ao solicitar: ' + (error.message || 'Sem conexão'));
        return;
    }

    if (!data.ok) {
        alert('Falha: ' + data.error);
        return;
    }

    const activationId = data.activation_id;
    const number       = data.numero;
    const finalPrice   = data.preco_aplicado;

    // Adiciona ao DOM imediatamente com skeleton
    renderActivationCard({
        id: activationId,
        phone_number: number,
        service_name: serviceName,
        status: 'waiting',
        sms_code: null,
        created_at: new Date().toISOString()
    });

    await updateUIForUser(); // Atualiza saldo subtraído
}

function renderActivationCard(act) {
    if (document.getElementById(act.id)) return;

    if (activeNumbers.querySelector('.empty-state')) activeNumbers.innerHTML = '';

    const sessionHTML = `
        <div class="session-card" id="${act.id}">
            <div class="session-info">
                <span class="number">${act.phone_number}</span>
                <span class="status" id="status-${act.id}">${act.status === 'received' ? 'RECEBIDO' : 'Aguardando SMS...'}</span>
            </div>
            <div style="font-size: 10px; color: #666; margin-bottom: 12px;">${act.service_name}</div>
            <div class="sms-code-display" id="code-${act.id}">${act.sms_code || '------'}</div>
            <div class="session-actions" id="actions-${act.id}">
                ${act.status === 'waiting' ? 
                    `<button class="btn-cancel" onclick="cancelActivation('${act.id}')" id="cancel-${act.id}">CANCELAR</button>` 
                    : `<div style="color: #D4AF37; font-size: 10px; font-weight: 800; text-align: center;">✓ CONCLUÍDO</div>`
                }
            </div>
        </div>
    `;

    activeNumbers.insertAdjacentHTML('afterbegin', sessionHTML);
}

async function cancelActivation(id) {
    const { data, error } = await supabase.rpc('rpc_cancelar_ativacao', {
        p_user_id: currentUser.id,
        p_activation_id: id
    });

    if (error) {
        alert('Erro ao cancelar: ' + error.message);
    } else if (!data.ok) {
        alert('Não foi possível cancelar: ' + data.error);
    } else {
        document.getElementById(id).remove();
        updateUIForUser(); // Saldo devolvido
    }
}

// === REALTIME & SYNC ===

async function loadActiveSessions() {
    const { data: acts } = await supabase
        .from('activations')
        .select('*')
        .eq('user_id', currentUser.id)
        .in('status', ['waiting', 'received'])
        .order('created_at', { ascending: false });

    if (acts && acts.length > 0) {
        activeNumbers.innerHTML = '';
        acts.forEach(renderActivationCard);
    }
}

function setupRealtime() {
    // 1. Escuta atualizações de SMS Recebido
    supabase.channel('my-activations')
        .on('postgres_changes', { 
            event: 'UPDATE', 
            schema: 'public', 
            table: 'activations',
            filter: `user_id=eq.${currentUser.id}` 
        }, payload => {
            const act = payload.new;
            if (act.status === 'received' && act.sms_code) {
                updateCardWithSMS(act.id, act.sms_code);
            } else if (act.status === 'cancelled' || act.status === 'expired') {
                document.getElementById(act.id)?.remove();
            }
        })
        .subscribe();

    // 2. Escuta mudanças de saldo (Admin ou Recarga)
    supabase.channel('my-profile')
        .on('postgres_changes', { 
            event: 'UPDATE', 
            schema: 'public', 
            table: 'profiles',
            filter: `id=eq.${currentUser.id}` 
        }, updateUIForUser)
        .subscribe();
}

function updateCardWithSMS(id, code) {
    const codeDisplay = document.getElementById(`code-${id}`);
    const statusEl = document.getElementById(`status-${id}`);
    const actionsArea = document.getElementById(`actions-${id}`);

    if (codeDisplay) {
        codeDisplay.innerText = code;
        codeDisplay.style.color = '#D4AF37';
        statusEl.innerText = 'RECEBIDO';
        statusEl.style.color = '#D4AF37';
        actionsArea.innerHTML = `<div style="color: #D4AF37; font-size: 10px; font-weight: 800; text-align: center;">✓ SMS RECEBIDO</div>`;
    }
}

init();
