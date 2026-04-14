/**
 * FluxSMS - Admin Master Control Logic
 */

// Configuração Supabase (O GitHub Actions substituirá estas chaves no deploy)
const SUPABASE_URL  = 'https://ewwhywbwtqwtuujemtfk.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV3d2h5d2J3dHF3dHV1amVtdGZrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYwOTAzMjYsImV4cCI6MjA5MTY2NjMyNn0.pgv9mkWHlq6wam7-BrN-zmlNDgyf-sDFTc1KT8IjvuU';

let db = null;
const ADMIN_EMAIL = 'iarachorta@gmail.com';

// Inicialização
async function init() {
    if (SUPABASE_URL.includes('__')) {
        console.error('Supabase keys not configured.');
        return;
    }

    supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON);

        .select('is_admin')
        .eq('id', user.id)
        .single();

    if (!profile || !profile.is_admin) {
        document.getElementById('access-denied').style.display = 'flex';
        return;
    }

    // 3. Carrega Dados Iniciais
    loadStats();
    loadUsers();
    loadChips();
    loadPolos();

    // 4. Inicia Listeners Realtime
    setupRealtime();
}

// === CARREGAMENTO DE DADOS ===

async function loadStats() {
    // Total Usuários
    const { count: userCount } = await db.from('profiles').select('*', { count: 'exact', head: true });
    // Saldo Global
    const { data: balances } = await db.from('profiles').select('balance');
    const totalBalance = balances.reduce((acc, curr) => acc + (curr.balance || 0), 0);
    // Chips
    const { data: chips } = await db.from('chips').select('status');
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
    let query = db.from('profiles').select('*').order('created_at', { ascending: false });
    
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
    const { data: chips } = await db.from('chips').select('*').order('porta');
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
    
    const { data, error } = await db.rpc('rpc_admin_set_user_status', {
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

    const { data, error } = await db.rpc('rpc_admin_adjust_balance', {
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

    const { error } = await db.from('custom_prices').upsert({
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
    db.channel('admin-changes')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, loadStats)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'chips' }, loadChips)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'polos' }, loadPolos)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'activations' }, loadStats)
        .subscribe();
}

// === GERENCIAMENTO DE POLOS (WORKERS) ===
async function loadPolos() {
    const { data: polos, error } = await db.from('polos').select('*').order('criado_em', { ascending: false });
    if (error) {
        console.error("Erro carregando polos:", error);
        return;
    }
    
    const tbody = document.querySelector('#table-polos tbody');
    if (!tbody) return;
    tbody.innerHTML = '';

    polos.forEach(p => {
        const lastSeen = p.ultima_comunicacao ? new Date(p.ultima_comunicacao).toLocaleString('pt-BR') : 'Sem Conexão';
        const isOnline = p.status === 'ONLINE';
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td style="font-weight:bold; color: white;">${p.nome}</td>
            <td>
                <div style="background: rgba(255,255,255,0.05); padding: 5px 12px; border-radius: 5px; font-family: monospace; display: flex; align-items:center; justify-content:space-between;">
                    <span style="font-size:12px; color:var(--gold);">${p.chave_acesso.substring(0, 20)}...</span>
                    <button class="btn-action" style="padding: 2px 10px; font-size: 11px;" onclick="navigator.clipboard.writeText('${p.chave_acesso}')">COPIAR</button>
                </div>
            </td>
            <td style="text-align:center; font-weight: 800;">${p.chips_ativos}</td>
            <td>
                <span class="status-badge ${isOnline ? 'status-online' : (p.status === 'INSTALL_PENDING' ? 'status-busy' : 'status-offline')}">
                    ${p.status === 'INSTALL_PENDING' ? 'Aguardando Instalação' : p.status}
                </span><br>
                <span style="font-size:10px; color: rgba(255,255,255,0.4);">Visto: ${lastSeen}</span>
            </td>
            <td>
                <button class="btn-action" style="border-color: #ff4444; color: #ff4444;" onclick="deletarPolo('${p.id}')">Excluir</button>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

function gerarChaveAleatoria() {
    return 'FLUX_' + Math.random().toString(36).substr(2, 9).toUpperCase() + '_' + Date.now().toString(36).toUpperCase();
}

window.gerarPolo = async function() {
    const nome = document.getElementById('polo-nome-input').value.trim();
    if (!nome) {
        alert("Digite um nome para o local (Ex: Casa Ju).");
        return;
    }
    const btn = event.target;
    btn.innerText = "GERANDO...";
    
    const chave = gerarChaveAleatoria();
    
    // Inserir no Supabase (Assegure que RLS policy permite insert)
    const { data, error } = await db.from('polos').insert([
        { nome: nome, chave_acesso: chave, status: 'INSTALL_PENDING' }
    ]);
    
    btn.innerText = "+ CRIAR POLO AGORA";

    if (error) {
        alert("Erro ao criar polo no banco: " + error.message);
    } else {
        alert("Polo criado com sucesso! Copie a chave exibida e envie para o operador local.");
        document.getElementById('polo-nome-input').value = '';
        loadPolos(); // Força load caso realtime sinta atraso
    }
}

window.deletarPolo = async function(id) {
    if(!confirm("⚠️ AVISO CRÍTICO: Excluir este Polo vai DESCONECTAR a máquina física associada a ele. O Worker irá parar de enviar dados.\\n\\nTem certeza que deseja excluir o Polo?")) return;
    
    const { error } = await db.from('polos').delete().eq('id', id);
    if(error) alert("Erro ao excluir polo: " + error.message);
    else loadPolos();
}

init();
