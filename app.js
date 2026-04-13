// === SUPABASE CLIENT ===
// Em produção: __SUPABASE_URL__ e __SUPABASE_ANON_KEY__ são substituídos pelo GitHub Actions
// Em desenvolvimento: use os valores reais direto aqui
const SUPABASE_URL  = '__SUPABASE_URL__';
const SUPABASE_ANON = '__SUPABASE_ANON_KEY__';

let supabase = null;
let currentUser = null;

// Inicializa Supabase apenas se as chaves estiverem presentes (produção)
if (!SUPABASE_URL.includes('__') && !SUPABASE_ANON.includes('__')) {
    supabase = window.supabase?.createClient(SUPABASE_URL, SUPABASE_ANON);
}

// === LISTA COMPLETA DE SERVIÇOS ===
const SERVICES = [
    { id: 'whatsapp',    name: 'WhatsApp',      price: 6.10 },
    { id: 'telegram',    name: 'Telegram',      price: 4.00 },
    { id: 'google',      name: 'Google',        price: 1.50 },
    { id: 'uber',        name: 'Uber',          price: 1.20 },
    { id: 'tinder',      name: 'Tinder',        price: 4.50 },
    { id: 'gov',         name: 'GOV.BR',        price: 5.00 },
    { id: 'ifood',       name: 'iFood',         price: 0.90 },
    { id: 'instagram',   name: 'Instagram',     price: 2.00 },
    { id: 'facebook',    name: 'Facebook',      price: 1.80 },
    { id: 'tiktok',      name: 'TikTok',        price: 1.50 },
    { id: 'microsoft',   name: 'Microsoft',     price: 1.20 },
    { id: 'apple',       name: 'Apple ID',      price: 3.00 },
    { id: 'discord',     name: 'Discord',       price: 1.00 },
    { id: 'shopee',      name: 'Shopee',        price: 0.80 },
    { id: 'amazon',      name: 'Amazon',        price: 1.10 },
    { id: 'mercadolivre',name: 'Mercado Livre', price: 1.20 },
    { id: 'nubank',      name: 'Nubank',        price: 2.50 },
    { id: 'twitter',     name: 'X (Twitter)',   price: 1.00 },
    { id: 'linkedin',    name: 'LinkedIn',      price: 1.50 },
    { id: 'snapchat',    name: 'Snapchat',      price: 1.50 },
    { id: 'paypal',      name: 'PayPal',        price: 2.00 },
    { id: 'kwai',        name: 'Kwai',          price: 0.80 },
    { id: 'badoo',       name: 'Badoo',         price: 1.50 },
    { id: 'bumble',      name: 'Bumble',        price: 1.50 }
];

// === ESTADO GLOBAL ===
// IMPORTANTE: Em produção, cada usuário só verá SUAS sessões (isolamento por token/login)
// O 'sessionStore' simula esse isolamento: cada entrada é vinculada a um sessionId único
let sessionStore = {}; // { sessionId: { service, number, status, code } }
let modemsDisponiveis = 10;

const servicesGrid = document.getElementById('services-grid');
const activeNumbers = document.getElementById('active-numbers');
const searchInput = document.getElementById('service-search');

// === INICIALIZAÇÃO ===
function init() {
    renderServices(SERVICES);
    document.getElementById('services-count').innerText = `${SERVICES.length} Serviços`;
    
    searchInput.addEventListener('input', () => {
        const q = searchInput.value.toLowerCase();
        const filtered = SERVICES.filter(s => s.name.toLowerCase().includes(q));
        renderServices(filtered);
    });
}

function renderServices(list) {
    const sem_estoque = modemsDisponiveis <= 0;
    servicesGrid.innerHTML = list.map(s => `
        <div class="service-row">
            <div class="name">${s.name}</div>
            <div class="price">R$ ${s.price.toFixed(2)}</div>
            <div class="action">
                <button class="btn-buy" 
                        onclick="requestNumber('${s.id}', '${s.name}', ${s.price})"
                        ${sem_estoque ? 'disabled title="Sem números disponíveis no momento"' : ''}>
                    ${sem_estoque ? 'SEM ESTOQUE' : 'SOLICITAR'}
                </button>
            </div>
        </div>
    `).join('');
}

// === SOLICITAR NÚMERO ===
// TRAVA DE ISOLAMENTO: Cada clique gera um sessionId único.
// O usuário X que comprou WhatsApp só verá o código do WhatsApp.
// O usuário Y que comprou Telegram só verá o código do Telegram.
// Os códigos NUNCA se cruzam porque são filtrados por sessionId.
function requestNumber(serviceId, serviceName, price) {
    if(modemsDisponiveis <= 0) return;

    modemsDisponiveis--;
    renderServices(SERVICES);

    // Gera um ID único para esta transação (em produção, vem do backend)
    const sessionId = 'session_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
    const fakeNumber = '+55 47 9' + Math.floor(10000000 + Math.random() * 89999999);

    // Registra a sessão no store local (isolamento)
    sessionStore[sessionId] = {
        serviceId,
        serviceName,
        price,
        number: fakeNumber,
        status: 'aguardando',
        code: null
    };

    if(activeNumbers.querySelector('.empty-state')) activeNumbers.innerHTML = '';

    const sessionHTML = `
        <div class="session-card" id="${sessionId}">
            <div class="session-info">
                <span class="number">${fakeNumber}</span>
                <span class="status" id="status-${sessionId}">Aguardando SMS...</span>
            </div>
            <div style="font-size: 10px; color: #666; margin-bottom: 12px;">${serviceName}</div>
            <div class="sms-code-display" id="code-${sessionId}">------</div>
            <div class="session-actions" id="actions-${sessionId}">
                <button class="btn-cancel" disabled id="cancel-${sessionId}">CANCELAR (120s)</button>
            </div>
            <div class="countdown-timer" id="timer-${sessionId}">Cancelamento liberado em 2 minutos.</div>
        </div>
    `;

    activeNumbers.insertAdjacentHTML('afterbegin', sessionHTML);
    startSessionLogic(sessionId);
}

// === LÓGICA DE CRONÔMETRO E TRAVA ===
function startSessionLogic(sessionId) {
    let timeLeft = 120;
    const cancelBtn = document.getElementById(`cancel-${sessionId}`);
    const timerEl = document.getElementById(`timer-${sessionId}`);

    const countdown = setInterval(() => {
        timeLeft--;
        if(timeLeft > 0) {
            cancelBtn.innerText = `CANCELAR (${timeLeft}s)`;
        } else {
            clearInterval(countdown);
            // Só libera cancelamento se o código AINDA não chegou
            if(sessionStore[sessionId] && sessionStore[sessionId].status !== 'concluido') {
                cancelBtn.disabled = false;
                cancelBtn.innerText = "CANCELAR E PEDIR REEMBOLSO";
                timerEl.innerText = "Código não chegou? Cancele agora.";
            }
        }
    }, 1000);

    // SIMULAÇÃO: SMS chega entre 15 e 45 segundos
    const arrivalTime = (Math.floor(Math.random() * 30) + 15) * 1000;
    setTimeout(() => {
        if(document.getElementById(sessionId) && sessionStore[sessionId]) {
            const fakeCode = Math.floor(100000 + Math.random() * 900000).toString();
            deliverSMS(sessionId, fakeCode, countdown);
        }
    }, arrivalTime);
}

// === ENTREGA DO SMS (TRAVA TOTAL DE REEMBOLSO) ===
// ISOLAMENTO GARANTIDO: o código é gravado APENAS no elemento com o sessionId específico.
// Nenhum outro usuário/sessão tem acesso a este elemento.
function deliverSMS(sessionId, code, countdownTimer) {
    if(!sessionStore[sessionId]) return;

    clearInterval(countdownTimer);

    // Marca como concluído no store (impede cancelamento pós-entrega)
    sessionStore[sessionId].status = 'concluido';
    sessionStore[sessionId].code = code;

    const codeDisplay = document.getElementById(`code-${sessionId}`);
    const actionsArea = document.getElementById(`actions-${sessionId}`);
    const statusEl = document.getElementById(`status-${sessionId}`);
    const card = document.getElementById(sessionId);
    const timerEl = document.getElementById(`timer-${sessionId}`);

    // Exibe o código APENAS nesta sessão
    codeDisplay.innerText = code;
    codeDisplay.style.color = '#D4AF37';
    card.style.borderColor = '#D4AF37';
    statusEl.innerText = 'FINALIZADO';
    statusEl.style.color = '#D4AF37';

    // REMOVE BOTÕES DE CANCELAR E REEMBOLSO (TRAVA TOTAL conforme os vídeos)
    actionsArea.innerHTML = `
        <div style="color: #D4AF37; font-size: 10px; font-weight: 800; text-align: center; border: 1px solid #D4AF3355; padding: 8px; width: 100%; border-radius: 4px;">
            ✓ SMS RECEBIDO — TRANSAÇÃO CONCLUÍDA
        </div>`;
    if(timerEl) timerEl.remove();

    // Libera um slot de modem de volta
    modemsDisponiveis++;
    renderServices(SERVICES);
}

init();
