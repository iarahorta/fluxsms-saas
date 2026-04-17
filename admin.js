/**
 * FluxSMS - Admin Master Control Logic
 */

// Configuração Supabase (O GitHub Actions substituirá estas chaves no deploy)
const SUPABASE_URL  = '__SUPABASE_URL__';
const SUPABASE_ANON = '__SUPABASE_ANON_KEY__';

let db = null;
const ADMIN_EMAIL = 'iarachorta@gmail.com';

// Inicialização
async function init() {
    if (SUPABASE_URL.includes('__')) {
        console.error('Supabase keys not configured.');
        return;
    }

    db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON);

    const { data: { session } } = await db.auth.getSession();
    
    if (!session) {
        window.location.href = '../index.html';
        return;
    }
    
    const user = session.user;
    const adminMailBox = document.getElementById('admin-mail');
    if (adminMailBox) adminMailBox.innerText = user.email;

    const { data: profile } = await db.from('profiles')
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
    loadGlobalPrices();

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
    const { count: smsCount } = await db
        .from('activations')
        .select('*', { count: 'exact', head: true })
        .gte('created_at', today.toISOString());

    if (document.getElementById('stat-users')) document.getElementById('stat-users').innerText = userCount || 0;
    if (document.getElementById('stat-balance')) document.getElementById('stat-balance').innerText = `R$ ${totalBalance.toLocaleString('pt-BR', {minimumFractionDigits: 2})}`;
    if (document.getElementById('stat-chips')) document.getElementById('stat-chips').innerText = `${onlineChips}/${chips ? chips.length : 0}`;
    if (document.getElementById('stat-sms')) document.getElementById('stat-sms').innerText = smsCount || 0;
}

async function loadUsers(search = '') {
    let query = db.from('profiles').select('*').order('created_at', { ascending: false });
    
    if (search) {
        query = query.ilike('email', `%${search}%`);
    }

    const { data: users, error } = await query;
    if (error) { console.error("Erro ao carregar usuários:", error); return; }

    const tbody = document.querySelector('#table-users tbody');
    if (!tbody) return;
    tbody.innerHTML = '';

    if (users) {
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
    try {
        const { data: chips, error } = await db.from('chips').select('*').order('porta');
        const tbody = document.querySelector('#table-chips tbody');
        if (!tbody || error) return;
        tbody.innerHTML = '';

        chips.forEach(c => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>Porta ${c.porta}</td>
                <td style="font-family: monospace;">${c.numero || 'Vazio'}</td>
                <td>
                    <span class="status-badge ${c.status === 'idle' ? 'status-online' : (c.status === 'offline' ? 'status-offline' : 'status-busy')}">
                        ${c.status.toUpperCase()}
                    </span>
                </td>
            `;
            tbody.appendChild(tr);
        });
    } catch (err) {
        console.error("Erro ao carregar chips:", err);
    }
}

async function loadGlobalPrices() {
    const { data: services } = await db.from('services_config').select('*').order('name');
    if (!services) return;

    // 1. Preenche a tabela de preços globais
    const tbody = document.querySelector('#table-global-prices tbody');
    if (tbody) {
        tbody.innerHTML = '';
        services.forEach(s => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${s.name}</td>
                <td>
                    <input type="number" step="0.01" class="price-input" id="global-price-${s.id}" value="${s.price.toFixed(2)}" 
                           style="width: 70px; background: transparent; border: 1px solid var(--gold); color: white; border-radius: 4px; padding: 2px 5px;">
                </td>
                <td>
                    <button class="btn-action" style="padding: 2px 8px; font-size: 11px;" onclick="updateGlobalPrice('${s.id}')">SALVAR</button>
                </td>
            `;
            tbody.appendChild(tr);
        });
    }

    // 2. Preenche os selects de serviços (form custom_price)
    const select = document.getElementById('price-service');
    if (select) {
        select.innerHTML = services.map(s => `<option value="${s.id}">${s.name}</option>`).join('');
    }
}

async function updateGlobalPrice(serviceId) {
    const newVal = parseFloat(document.getElementById(`global-price-${serviceId}`).value);
    if (isNaN(newVal)) return;

    const { error } = await db.from('services_config').update({ price: newVal, updated_at: new Date() }).eq('id', serviceId);
    if (error) alert('Erro ao atualizar: ' + error.message);
    else alert('Preço global atualizado com sucesso!');
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
    const email = document.getElementById('price-user-email').value.trim();
    const service = document.getElementById('price-service').value;
    const price = parseFloat(document.getElementById('price-value').value);

    // Busca o ID do usuário pelo email
    const { data: userProfile, error: userErr } = await db.from('profiles').select('id').ilike('email', email).single();
    if (userErr || !userProfile) {
        alert('Usuário não encontrado com este e-mail.');
        return;
    }

    const { error } = await db.from('custom_prices').upsert({
        user_id: userProfile.id,
        service: service,
        price: price
    });

    if (error) alert('Erro ao definir preço: ' + error.message);
    else alert(`Preço VIP salvo para ${email}!`);
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
