/**
 * FluxSMS - Admin Master Control Logic
 */

// Configuração Supabase (O GitHub Actions substituirá estas chaves no deploy)
const SUPABASE_URL  = 'https://ewwhywbwtqwtuujemtfk.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV3d2h5d2J3dHF3dHV1amVtdGZrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYwOTAzMjYsImV4cCI6MjA5MTY2NjMyNn0.pgv9mkWHlq6wam7-BrN-zmlNDgyf-sDFTc1KT8IjvuU';

let supabase = null;
const ADMIN_EMAIL = 'iarachorta@gmail.com';

// Inicialização
async function init() {
    if (SUPABASE_URL.includes('__')) {
        console.error('Supabase keys not configured.');
        return;
    }

    supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON);

    // 1. Verifica Autenticação e Segurança
    const { data: { user } } = await supabase.auth.getUser();

    if (!user || user.email !== ADMIN_EMAIL) {
        document.getElementById('access-denied').style.display = 'flex';
        return;
    }

    // 2. Verifica Flag Admin no Profile (Segunda camada)
    const { data: profile } = await supabase
        .from('profiles')
        .select('is_admin')
        .eq('id', user.id)
        .single();

    if (!profile || !profile.is_admin) {
        document.getElementById('access-denied').style.display = 'flex';
        return;
    }

    document.getElementById('admin-mail').innerText = user.email;

    // 3. Carrega Dados Iniciais
    loadStats();
    loadUsers();
    loadChips();

    // 4. Inicia Listeners Realtime
    setupRealtime();
}

// === CARREGAMENTO DE DADOS ===

async function loadStats() {
    // Total Usuários
    const { count: userCount } = await supabase.from('profiles').select('*', { count: 'exact', head: true });
    // Saldo Global
    const { data: balances } = await supabase.from('profiles').select('balance');
    const totalBalance = balances.reduce((acc, curr) => acc + (curr.balance || 0), 0);
    // Chips
    const { data: chips } = await supabase.from('chips').select('status');
    const onlineChips = chips.filter(c => c.status !== 'offline').length;
    // SMS Hoje
    const today = new Date();
    today.setHours(0,0,0,0);
    const { count: smsCount } = await supabase
        .from('activations')
        .select('*', { count: 'exact', head: true })
        .gte('created_at', today.toISOString());

    document.getElementById('stat-users').innerText = userCount;
    document.getElementById('stat-balance').innerText = `R$ ${totalBalance.toLocaleString('pt-BR', {minimumFractionDigits: 2})}`;
    document.getElementById('stat-chips').innerText = `${onlineChips}/${chips.length}`;
    document.getElementById('stat-sms').innerText = smsCount;
}

async function loadUsers(search = '') {
    let query = supabase.from('profiles').select('*').order('created_at', { ascending: false });
    
    if (search) {
        query = query.ilike('email', `%${search}%`);
    }

    const { data: users } = await query;
    const tbody = document.querySelector('#table-users tbody');
    tbody.innerHTML = '';

    users.forEach(u => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${u.email}</td>
            <td style="color: var(--gold); font-weight: 700;">R$ ${u.balance.toFixed(2)}</td>
            <td>
                <span class="status-badge ${u.is_active ? 'status-online' : 'status-offline'}">
                    ${u.is_active ? 'Ativo' : 'Banido'}
                </span>
            </td>
            <td>
                <button class="btn-action" onclick="openBalanceModal('${u.id}', '${u.email}')">Saldo</button>
                <button class="btn-action" style="border-color: #ff4444; color: #ff4444;" onclick="toggleUserStatus('${u.id}', ${u.is_active})">
                    ${u.is_active ? 'Banir' : 'Reativar'}
                </button>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

async function loadChips() {
    const { data: chips } = await supabase.from('chips').select('*').order('porta');
    const tbody = document.querySelector('#table-chips tbody');
    tbody.innerHTML = '';

    chips.forEach(c => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${c.porta}</td>
            <td>${c.numero || '---'}</td>
            <td>
                <span class="status-badge status-${c.status}">${c.status}</span>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

// === AÇÕES DE ADMIN ===

async function toggleUserStatus(userId, currentStatus) {
    if (!confirm(`Tem certeza que deseja ${currentStatus ? 'BANIR' : 'REATIVAR'} este usuário?`)) return;
    
    const { data, error } = await supabase.rpc('rpc_admin_set_user_status', {
        p_user_id: userId,
        p_active: !currentStatus
    });

    if (error) alert('Erro ao alterar status: ' + error.message);
    else loadUsers();
}

function openBalanceModal(userId, email) {
    document.getElementById('modal-balance').style.display = 'flex';
    document.getElementById('modal-title').innerText = `Ajustar Saldo: ${email}`;
    document.getElementById('balance-target-id').value = userId;
}

function closeModal() {
    document.getElementById('modal-balance').style.display = 'none';
}

document.getElementById('form-balance').onsubmit = async (e) => {
    e.preventDefault();
    const userId = document.getElementById('balance-target-id').value;
    const amount = parseFloat(document.getElementById('balance-amount').value);
    const desc = document.getElementById('balance-note').value;

    const { data, error } = await supabase.rpc('rpc_admin_adjust_balance', {
        p_user_id: userId,
        p_amount: amount,
        p_description: desc
    });

    if (error) alert('Erro ao ajustar saldo: ' + error.message);
    else {
        alert('Saldo ajustado com sucesso!');
        closeModal();
        loadUsers();
        loadStats();
    }
};

document.getElementById('form-custom-price').onsubmit = async (e) => {
    e.preventDefault();
    const userId = document.getElementById('price-user-id').value;
    const service = document.getElementById('price-service').value;
    const price = parseFloat(document.getElementById('price-value').value);

    const { error } = await supabase.from('custom_prices').upsert({
        user_id: userId,
        service: service,
        price: price
    });

    if (error) alert('Erro ao definir preço: ' + error.message);
    else alert('Preço customizado salvo!');
};

// Busca em tempo real
document.getElementById('user-search').oninput = (e) => loadUsers(e.target.value);

// Realtime
function setupRealtime() {
    supabase.channel('admin-changes')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, loadStats)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'chips' }, loadChips)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'activations' }, loadStats)
        .subscribe();
}

init();
