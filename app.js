/**
 * FluxSMS - Frontend Business Logic (Realtime & Supabase Integration)
 */

// === SUPABASE CLIENT ===
// Em produção: __SUPABASE_URL__ e __SUPABASE_ANON_KEY__ são substituídos pelo GitHub Actions
const SUPABASE_URL  = 'https://ewwhywbwtqwtuujemtfk.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV3d2h5d2J3dHF3dHV1amVtdGZrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYwOTAzMjYsImV4cCI6MjA5MTY2NjMyNn0.pgv9mkWHlq6wam7-BrN-zmlNDgyf-sDFTc1KT8IjvuU';

let db = null;
let currentUser = null;

// Inicializa Supabase
if (!SUPABASE_URL.includes('__') && !SUPABASE_ANON.includes('__')) {
    db = window.supabase?.createClient(SUPABASE_URL, SUPABASE_ANON);
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

// === ELEMENTOS DE NAVEGAÇÃO ===
// === ELEMENTOS DE NAVEGAÇÃO ===
const landingView   = document.getElementById('landing-view');
const dashboardView = document.getElementById('dashboard-view');
const authModal     = document.getElementById('authModal');
const servicesGrid  = document.getElementById('services-grid');
const activeNumbers = document.getElementById('active-numbers');
const searchInput   = document.getElementById('service-search');

// === INICIALIZAÇÃO ===
async function init() {
    if (!db) {
        console.warn('Supabase não configurado. Rodando em modo simulação.');
        renderServices(SERVICES);
        return;
    }

    // 1. Verifica Sessão
    const { data: { session } } = await db.auth.getSession();
    toggleViews(session);

    if (session) {
        currentUser = session.user;
        updateUIForUser();
        loadActiveSessions();
        setupRealtime();
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
    db.auth.onAuthStateChange((event, session) => {
        console.log('Auth Event:', event);
        if (event === 'SIGNED_IN' || event === 'INITIAL_SESSION') {
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
            window.location.reload();
        }
    });
}

function toggleViews(session) {
    if (session) {
        landingView.style.display = 'none';
        dashboardView.style.display = 'block';
    } else {
        landingView.style.display = 'block';
        dashboardView.style.display = 'none';
    }
}

// === AUTHENTICATION ===
async function handleAuth(type) {
    try {
        if (!db) throw new Error("A conexão com o banco de dados (Supabase) não foi iniciada. Verifique sua conexão com a internet ou adblocker.");

        if (type === 'login') {
            const email = document.getElementById('auth-email').value;
            const password = document.getElementById('auth-password').value;
            console.log("Tentando login para:", email);
            
            const { data, error } = await db.auth.signInWithPassword({ email, password });
            
            if (error) {
                console.error("Supabase Login Error:", error);
                alert('Falha no login: ' + error.message);
            } else {
                console.log("Login SUCESSO!");
            }
        } else {
            const email = document.getElementById('reg-email').value;
            const password = document.getElementById('reg-password').value;
            const name = document.getElementById('reg-name').value;
            
            console.log("Tentando cadastro para:", email);
            
            if (!email || !password || !name) {
                alert("Preencha todos os campos antes de cadastrar.");
                return;
            }

            const { data, error } = await db.auth.signUp({ 
                email, 
                password,
                options: { data: { full_name: name } }
            });
            
            if (error) {
                console.error("Supabase SignUp Error:", error);
                alert('Recusado pelo sistema: ' + error.message);
                return; // Para a execução
            } 
            
            console.log("Cadastro inicial feito com sucesso:", data);
            
            // Login automático imediato
            if (!data.session) {
                console.log("O usuário não logou direto. Tentando forçar signInWithPassword agora...");
                const { error: signInError } = await db.auth.signInWithPassword({ email, password });
                if (signInError) {
                    if (signInError.message.includes('Invalid login credentials')) {
                        alert('⚠️ Este e-mail já existe no banco e a senha informada não confere. Por favor, vá na aba ENTRAR.');
                    } else if (signInError.message.includes('Email not confirmed')) {
                        alert('⚠️ O seu e-mail precia ser Confirmado (Entre em contato com Iara e ela ativará na mesma hora!).');
                    } else {
                        alert('Erro na entrada da fila: ' + signInError.message);
                    }
                }
            } else {
                console.log("Cadastro já retornou sessão ativa! As janelas fecharão sozinhas agorinha.");
            }
        }
    } catch (err) {
        console.error("Erro crítico no handleAuth:", err);
        alert("Erro Crítico no sistema de botões: " + err.message);
    }
}


async function handleLogout() {
    await db.auth.signOut();
}

async function gerarPix() {
    const amount = parseFloat(document.getElementById('valorRecarga').value);
    if (!amount || amount < 5) { alert('⚠️ Valor mínimo para recarga é de R$ 5,00'); return; }

    alert(`🪙 As recargas automáticas via Gateway estão temporariamente desabilitadas para manutenção.\n\nPara inserir R$ ${amount.toFixed(2)} na sua conta, por favor envie um Pix direto e informe o seu e-mail ao nosso Suporte (WhatsApp). Seu saldo cairá na mesma hora assim que acionarmos o seu painel!`);
}

async function loadChipsCount() {
    // const { count } = await db.from('chips').select('*', { count: 'exact', head: true }).eq('status', 'idle');
    chipsDisponiveis = 99; // count || 0; (Travado em 99 para Testes Iara)
    renderServices(SERVICES);
}

async function updateUIForUser() {
    if (!currentUser) return;

    // Atualiza saldo real do profiles
    const { data: profile } = await db.from('profiles').select('*').eq('id', currentUser.id).single();
    if (profile) {
        // Atualiza saldos nos dois lugares possíveis
        const balDesktop = document.getElementById('balance-display');
        const balMobile = document.getElementById('balance-display-mobile');
        const initials = document.getElementById('user-initials');

        const balanceFormatted = `R$ ${profile.balance.toFixed(2)}`;
        if (balDesktop) balDesktop.innerText = balanceFormatted;
        if (balMobile) balMobile.innerText = balanceFormatted;
        
        if (initials && profile.full_name) {
            initials.innerText = profile.full_name.split(' ').map(n => n[0]).join('').toUpperCase().substring(0, 2);
        }
        
        // Se for admin, mostra link do painel no menu
        if (profile.is_admin && !document.getElementById('btn-admin-link')) {
             const sidebarNav = document.querySelector('.main-nav');
             const adminLink = document.createElement('a');
             adminLink.id = 'btn-admin-link';
             adminLink.href = 'admindiretoria/index.html';
             adminLink.className = 'nav-item';
             adminLink.style.color = 'var(--flux-gold)';
             adminLink.innerHTML = `<span class="icon">⚙️</span> Painel Admin`;
             sidebarNav.insertBefore(adminLink, sidebarNav.firstChild);
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
    const { data, error } = await db.rpc('rpc_solicitar_sms_v2', {
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
    const { data, error } = await db.rpc('rpc_cancelar_ativacao', {
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
    const { data: acts } = await db
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

let isRealtimeActive = false;

function setupRealtime() {
    if (isRealtimeActive) return;
    isRealtimeActive = true;

    // 1. Escuta atualizações de SMS Recebido
    db.channel('my-activations')
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
    db.channel('my-profile')
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
