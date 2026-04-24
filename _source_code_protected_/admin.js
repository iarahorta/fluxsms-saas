/**
 * FluxSMS - Admin Master Control Logic
 */

// === SUPABASE CLIENT ===
const SUPABASE_URL  = 'https://ewwhywbwtqwtuujemtfk.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV3d2h5d2J3dHF3dHV1amVtdGZrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYwOTAzMjYsImV4cCI6MjA5MTY2NjMyNn0.pgv9mkWHlq6wam7-BrN-zmlNDgyf-sDFTc1KT8IjvuU';

let db = null;
const ADMIN_EMAIL = 'iarachorta@gmail.com';
let chipTab = 'on';
let chipPanelCollapsed = true;

const ADMIN_BACKEND_URL = '__BACKEND_URL__'.includes('http') && !'__BACKEND_URL__'.includes('localhost')
    ? '__BACKEND_URL__'
    : (typeof window !== 'undefined' && window.location.hostname.includes('railway.app')
        ? window.location.origin
        : 'https://fluxsms-staging-production.up.railway.app');

// Inicialização
async function init() {
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
    loadPartnerApiAdmin();
    applyChipPanelState();

    // 4. Inicia Listeners Realtime
    setupRealtime();
}

// === CARREGAMENTO DE DADOS ===

async function loadStats() {
    // Busca estatísticas reias do banco (Motor V3 - Blindado)
    const { data: stats, error } = await db.rpc('rpc_get_admin_stats_v3');
    
    if (error) {
        console.error("Erro ao buscar estatísticas reais:", error);
        return;
    }

    if (document.getElementById('stat-users')) document.getElementById('stat-users').innerText = stats.users_count || 0;
    if (document.getElementById('stat-balance')) document.getElementById('stat-balance').innerText = `R$ ${stats.balance_total.toLocaleString('pt-BR', {minimumFractionDigits: 2})}`;
    if (document.getElementById('stat-chips')) document.getElementById('stat-chips').innerText = `${stats.chips_online || 0}/${stats.chips_total || 0}`;
    if (document.getElementById('stat-sms')) document.getElementById('stat-sms').innerText = stats.sms_count || 0;
    
    // GATILHO DE SEGURANÇA: Sempre que abrir/atualizar o Admin, roda o Gari para limpar Polos mortos
    await db.rpc('rpc_monitorar_e_estornar_v2');
}

// === LIMPEZA FORÇADA (MANUAL) ===
window.limpezaForcadaAdmin = async function(e) {
    if (e) e.preventDefault();
    const btn = e ? e.target : null;
    const originalText = btn ? btn.innerText : "LIMPAR";
    
    if (btn) {
        btn.innerText = "LIMPANDO...";
        btn.disabled = true;
    }

    try {
        await db.rpc('rpc_monitorar_e_estornar_v2');
        await loadStats();
        await loadPolos();
        alert("🧹 Limpeza forçada concluída! Polos inativos foram offline e clientes estornados.");
    } catch(err) {
        alert("Erro na limpeza: " + err.message);
    } finally {
        btn.innerText = originalText;
        btn.disabled = false;
    }
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
                <button class="btn-action" onclick="openUserHistoryModal('${u.id}', '${u.email}')">Histórico</button>
                <button class="btn-action" style="border-color: #ff4444; color: #ff4444;" onclick="toggleUserStatus('${u.id}', ${u.is_active})">
                    ${u.is_active ? 'Banir' : 'Reativar'}
                </button>
            </td>
        `;
        tbody.appendChild(tr);
    });
    }
}

async function loadChips() {
    try {
        const { data: chips, error } = await db.from('chips').select('*').order('updated_at', { ascending: false });
        const tbodyOn = document.querySelector('#table-chips tbody');
        const tbodyOff = document.querySelector('#table-chips-off tbody');
        if (!tbodyOn || !tbodyOff || error) return;
        tbodyOn.innerHTML = '';
        tbodyOff.innerHTML = '';

        const allRows = dedupeChipRows(chips || []);
        const onRows = allRows.filter((c) => String(c.status || '').toLowerCase() === 'idle');
        const offRows = allRows.filter((c) => String(c.status || '').toLowerCase() !== 'idle');

        const renderRow = (c) => {
            const st = c.status || '';
            const badgeClass = st === 'idle' ? 'status-online' : (st === 'offline' ? 'status-offline' : 'status-busy');
            const waUntil = c.disponivel_em ? new Date(c.disponivel_em).toLocaleString('pt-BR') : '—';
            return `
                <td>Porta ${c.porta}</td>
                <td style="font-family: monospace;">${c.numero || 'Vazio'}</td>
                <td><span class="status-badge ${badgeClass}">${st.toUpperCase()}</span></td>
                <td style="font-size:11px;color:rgba(255,255,255,0.55);">${st === 'quarentena' && c.disponivel_em ? 'WA até ' + waUntil : waUntil}</td>
            `;
        };

        if (onRows.length === 0) {
            tbodyOn.innerHTML = '<tr><td colspan="4" style="text-align:center; opacity:0.55;">Nenhum modem ON no momento.</td></tr>';
        } else {
            onRows.forEach((c) => {
                const tr = document.createElement('tr');
                tr.innerHTML = renderRow(c);
                tbodyOn.appendChild(tr);
            });
        }

        if (offRows.length === 0) {
            tbodyOff.innerHTML = '<tr><td colspan="4" style="text-align:center; opacity:0.55;">Nenhum modem OFF/quarentena.</td></tr>';
        } else {
            offRows.forEach((c) => {
                const tr = document.createElement('tr');
                tr.innerHTML = renderRow(c);
                tbodyOff.appendChild(tr);
            });
        }
        setChipTab(chipTab);
    } catch (err) {
        console.error("Erro ao carregar chips:", err);
    }
}

function dedupeChipRows(rows) {
    const seen = new Set();
    const unique = [];
    for (const row of rows) {
        const numero = String(row.numero || '').trim();
        const porta = String(row.porta || '').trim();
        const status = String(row.status || '').trim().toLowerCase();
        const key = numero ? `n:${numero}` : `p:${porta}|s:${status}`;
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(row);
    }
    return unique;
}

window.setChipTab = function (tab) {
    chipTab = tab === 'off' ? 'off' : 'on';
    const onBtn = document.getElementById('chip-tab-on');
    const offBtn = document.getElementById('chip-tab-off');
    const onWrap = document.getElementById('table-chips')?.parentElement;
    const offWrap = document.getElementById('chips-off-wrapper');
    if (onWrap) onWrap.style.display = chipTab === 'on' ? 'block' : 'none';
    if (offWrap) offWrap.style.display = chipTab === 'off' ? 'block' : 'none';
    if (onBtn) onBtn.style.opacity = chipTab === 'on' ? '1' : '0.65';
    if (offBtn) offBtn.style.opacity = chipTab === 'off' ? '1' : '0.65';
};

function applyChipPanelState() {
    const panel = document.getElementById('chip-panel-content');
    const btn = document.getElementById('btn-toggle-chip-panel');
    if (panel) panel.style.display = chipPanelCollapsed ? 'none' : 'block';
    if (btn) btn.textContent = chipPanelCollapsed ? '☰' : '✕';
}

window.toggleChipPanel = function () {
    chipPanelCollapsed = !chipPanelCollapsed;
    applyChipPanelState();
};

async function loadGlobalPrices() {
    const { data: services, error } = await db.from('services_config').select('*').order('name');
    
    // Fallback caso a tabela esteja vazia (Primeiro acesso)
    const activeServices = (services && services.length > 0) ? services : [
        { id: 'whatsapp', name: 'WhatsApp', price: 6.10 },
        { id: 'telegram', name: 'Telegram', price: 4.00 },
        { id: 'google', name: 'Google', price: 1.50 },
        { id: 'uber', name: 'Uber', price: 1.20 },
        { id: 'apple', name: 'Apple ID', price: 3.00 }
    ];

    // 1. Preenche a tabela de preços globais
    const tbody = document.querySelector('#table-global-prices tbody');
    if (tbody) {
        tbody.innerHTML = '';
        activeServices.forEach(s => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${s.name}</td>
                <td>
                    <input type="number" step="0.01" class="price-input" id="global-price-${s.id}" value="${s.price.toFixed(2)}" 
                           style="width: 70px; background: rgba(255,255,255,0.05); border: 1px solid var(--gold); color: white; border-radius: 4px; padding: 2px 5px;">
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
        select.innerHTML = activeServices.map(s => `<option value="${s.id}" style="background:#111; color:white;">${s.name}</option>`).join('');
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
    }, { onConflict: 'user_id,service' });

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
        .on('postgres_changes', { event: '*', schema: 'public', table: 'services_config' }, loadGlobalPrices)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'activations' }, loadStats)
        .subscribe();
}

// === GERENCIAMENTO DE PARCEIROS (WORKERS) ===
async function loadPolos() {
    const { data: polos, error } = await db.from('polos').select('*').order('criado_em', { ascending: false });
    if (error) {
        console.error("Erro carregando polos:", error);
        return;
    }

    // Busca contagem de chips ativos por polo para o resumo individual
    const { data: chips } = await db.from('chips').select('polo_id, status');
    
    const tbody = document.querySelector('#table-polos tbody');
    if (!tbody) return;
    tbody.innerHTML = '';

    polos.forEach(p => {
        // Regra de 180 segundos para o Badge de Status entrar em OFFLINE automaticamente na tela
        const lastSeenDate = p.ultima_comunicacao ? new Date(p.ultima_comunicacao) : null;
        const isOnline = lastSeenDate && (new Date() - lastSeenDate < 180000); 
        
        const lastSeenStr = lastSeenDate ? lastSeenDate.toLocaleString('pt-BR') : 'Sem Conexão';
        const activeChips = chips ? chips.filter(c => c.polo_id === p.id && c.status === 'idle').length : 0;

        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td style="font-weight:bold; color: white;">${p.nome}</td>
            <td>
                <div style="background: rgba(255,255,255,0.05); padding: 5px 12px; border-radius: 5px; font-family: monospace; display: flex; align-items:center; justify-content:space-between;">
                    <span style="font-size:12px; color:var(--gold);">${p.chave_acesso.substring(0, 20)}...</span>
                    <button class="btn-action" style="padding: 2px 10px; font-size: 11px;" onclick="navigator.clipboard.writeText('${p.chave_acesso}')">COPIAR</button>
                </div>
            </td>
            <td style="text-align:center; font-weight: 800;">${activeChips}</td>
            <td>
                <span class="status-badge ${isOnline ? 'status-online' : 'status-offline'}">
                    ${isOnline ? 'ONLINE' : 'OFFLINE'}
                </span><br>
                <span style="font-size:10px; color: rgba(255,255,255,0.4);">Visto: ${lastSeenStr}</span>
            </td>
            <td>
                <button class="btn-action" style="margin-right: 5px;" onclick="editarPolo('${p.id}', '${p.nome}')">Editar</button>
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
        alert("Parceiro criado com sucesso! Copie a chave exibida e envie para o operador local.");
        document.getElementById('polo-nome-input').value = '';
        loadPolos(); // Força load caso realtime sinta atraso
    }
}

window.deletarPolo = async function(id) {
    if(!confirm("⚠️ AVISO CRÍTICO: Excluir este Parceiro vai DESCONECTAR a máquina física associada a ele. O Worker irá parar de enviar dados.\n\nTem certeza que deseja excluir este parceiro?")) return;
    
    const { error } = await db.from('polos').delete().eq('id', id);
    if(error) alert("Erro ao excluir polo: " + error.message);
    else loadPolos();
}

window.editarPolo = async function(id, nomeAtual) {
    const novoNome = prompt("Digite o novo nome para este Parceiro:", nomeAtual);
    if (!novoNome || novoNome === nomeAtual) return;

    const { error } = await db.from('polos').update({ nome: novoNome }).eq('id', id);
    if (error) alert("Erro ao atualizar nome: " + error.message);
    else loadPolos();
}

// === HISTÓRICO DE USUÁRIO ===
window.openUserHistoryModal = async function(userId, email) {
    document.getElementById('history-user-email').innerText = `Visualizando atividade de: ${email}`;
    document.getElementById('modal-user-history').style.display = 'flex';
    
    const summaryDiv = document.getElementById('history-summary');
    const tbody = document.querySelector('#table-user-history tbody');
    summaryDiv.innerHTML = "Carregando resumo...";
    tbody.innerHTML = "<tr><td colspan='5' style='text-align:center;'>Buscando ativações...</td></tr>";

    // 1. Busca ativações (Limite de 200 recentes para performance)
    const { data: acts, error } = await db.from('activations')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(200);

    if (error) { 
        alert('Erro ao carregar histórico: ' + error.message); 
        return; 
    }

    if (!acts || acts.length === 0) {
        summaryDiv.innerHTML = "<b>Nenhuma compra encontrada.</b>";
        tbody.innerHTML = "<tr><td colspan='5' style='text-align:center;'>O usuário ainda não realizou compras.</td></tr>";
        return;
    }

    // 2. Processa Resumo (Contagem por serviço)
    const summary = {};
    acts.forEach(a => {
        summary[a.service_name] = (summary[a.service_name] || 0) + 1;
    });

    summaryDiv.innerHTML = Object.entries(summary).map(([name, count]) => `
        <div class="summary-item">
            <b>${count}x</b>
            <span>${name}</span>
        </div>
    `).join('');

    // 3. Função para decodificar SMS (Inverte Base64 -> Reverse)
    function descramble(txt) {
        try { return atob(txt).split('').reverse().join(''); } catch(e) { return txt || '---'; }
    }

    // 4. Renderiza Tabela
    tbody.innerHTML = acts.map(a => `
        <tr>
            <td>${new Date(a.created_at).toLocaleString('pt-BR')}</td>
            <td><span class="badge-service">${a.service_name}</span></td>
            <td style="color:var(--gold);">R$ ${a.price.toFixed(2)}</td>
            <td style="font-family: monospace; color: #00ff00;">${a.status === 'received' ? descramble(a.sms_code) : '---'}</td>
            <td>
                <span class="status-badge ${a.status === 'received' ? 'status-online' : 'status-offline'}">
                    ${a.status.toUpperCase()}
                </span>
            </td>
        </tr>
    `).join('');
}

window.closeHistoryModal = function() {
    document.getElementById('modal-user-history').style.display = 'none';
};

// === PARTNER API KEYS (admin — sem SQL) ===
async function loadPartnerApiAdmin() {
    const wrap = document.getElementById('section-partner-api');
    const tbody = document.querySelector('#table-partner-api tbody');
    if (!wrap || !tbody) return;

    const { data: { session } } = await db.auth.getSession();
    if (!session) return;

    tbody.innerHTML = '<tr><td colspan="8">Carregando parceiros...</td></tr>';

    try {
        const res = await fetch(`${ADMIN_BACKEND_URL}/api/admin/partners`, {
            headers: { Authorization: `Bearer ${session.access_token}` }
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || !json.ok) {
            tbody.innerHTML = `<tr><td colspan="8" style="color:#f88;">${json.detail || json.error || res.statusText}</td></tr>`;
            return;
        }
        const partners = json.partners || [];
        if (partners.length === 0) {
            tbody.innerHTML = '<tr><td colspan="8">Nenhum <code>partner_profiles</code>. Crie parceiro (RPC / SQL 004) primeiro.</td></tr>';
            return;
        }

        let rows = '';
        for (const p of partners) {
            const pr = p.profile || {};
            const email = pr.email || '—';
            const kRes = await fetch(`${ADMIN_BACKEND_URL}/api/admin/partners/${p.id}/api-keys`, {
                headers: { Authorization: `Bearer ${session.access_token}` }
            });
            const kJson = await kRes.json().catch(() => ({}));
            const keys = (kJson.keys || []).length;
            const prio = !!p.saque_prioritario;
            const commission = Number.isFinite(Number(p.custom_commission)) ? Number(p.custom_commission) : 60;
            const hasOnlineChip = Array.isArray(p.chips) && p.chips.some((c) => String(c.status || '').toLowerCase() !== 'offline');
            const statusLabel = hasOnlineChip ? 'ONLINE' : 'OFFLINE';
            const statusClass = hasOnlineChip ? 'status-online' : 'status-offline';
            rows += `<tr>
                <td><code style="font-size:11px;">${p.partner_code || '—'}</code></td>
                <td>${email}</td>
                <td style="text-align:center;">${keys}</td>
                <td><span class="status-badge ${statusClass}">${statusLabel}</span></td>
                <td style="min-width:130px;">
                    <input type="number" min="1" max="100" step="1" id="commission-${p.id}" value="${commission}" style="width:64px;background:rgba(255,255,255,0.05);border:1px solid rgba(212,175,55,0.35);color:#fff;border-radius:6px;padding:4px 6px;">
                    <button type="button" class="btn-action" style="padding:3px 8px;font-size:10px;margin-left:6px;" onclick="updatePartnerCommission('${p.id}')">Salvar</button>
                </td>
                <td style="text-align:center;">
                    <input type="checkbox" ${prio ? 'checked' : ''} title="Ignora carência 48h/24h nos cálculos de saque"
                        onchange="toggleAdminSaquePrioritario('${p.id}', this.checked)" />
                </td>
                <td style="font-size:11px;color:rgba(255,255,255,0.5);">${p.id}</td>
                <td>
                    <button type="button" class="btn-action" onclick="generateAdminPartnerKey('${p.id}')">Gerar API Key</button>
                    <button type="button" class="btn-action" style="margin-left:6px;border-color:#ff7a7a;color:#ff7a7a;" onclick="forcePartnerOfflineNow('${p.id}')">Limpar Chips</button>
                </td>
            </tr>`;
        }
        tbody.innerHTML = rows;
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="8" style="color:#f88;">${e.message || e}</td></tr>`;
    }
}

window.updatePartnerCommission = async function (partnerProfileId) {
    const input = document.getElementById(`commission-${partnerProfileId}`);
    const prioEl = document.querySelector(`input[onchange*="toggleAdminSaquePrioritario('${partnerProfileId}'"]`);
    const value = input ? Number(input.value) : NaN;
    const prio = !!prioEl?.checked;
    if (!Number.isInteger(value) || value < 1 || value > 100) {
        alert('Comissão inválida. Use um inteiro entre 1 e 100.');
        return;
    }
    const { data: { session } } = await db.auth.getSession();
    if (!session) {
        alert('Sessão expirada.');
        return;
    }
    try {
        const res = await fetch(`${ADMIN_BACKEND_URL}/api/admin/partners/${partnerProfileId}`, {
            method: 'PATCH',
            headers: {
                Authorization: `Bearer ${session.access_token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ custom_commission: value, saque_prioritario: prio })
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok || !j.ok) {
            alert('Erro ao atualizar comissão: ' + (j.detail || j.error || res.statusText));
            return;
        }
        alert('Comissão atualizada com sucesso.');
        loadPartnerApiAdmin();
    } catch (e) {
        alert('Falha: ' + (e.message || e));
    }
};

window.toggleAdminSaquePrioritario = async function (partnerProfileId, checked) {
    const { data: { session } } = await db.auth.getSession();
    if (!session) {
        alert('Sessão expirada.');
        return;
    }
    try {
        const res = await fetch(`${ADMIN_BACKEND_URL}/api/admin/partners/${partnerProfileId}`, {
            method: 'PATCH',
            headers: {
                Authorization: `Bearer ${session.access_token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ saque_prioritario: !!checked })
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok || !j.ok) {
            alert('Erro ao atualizar: ' + (j.detail || j.error || res.statusText));
            loadPartnerApiAdmin();
            return;
        }
    } catch (e) {
        alert('Falha: ' + (e.message || e));
        loadPartnerApiAdmin();
    }
};

window.generateAdminPartnerKey = async function (partnerProfileId) {
    const label = window.prompt('Rótulo desta chave (ex.: PC estação SP):', 'FluxSMS Desktop');
    if (label === null) return;

    const { data: { session } } = await db.auth.getSession();
    if (!session) {
        alert('Sessão expirada.');
        return;
    }

    try {
        const res = await fetch(`${ADMIN_BACKEND_URL}/api/admin/partners/${partnerProfileId}/api-keys`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${session.access_token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ label: label || 'Admin Hub' })
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok || !j.ok) {
            alert('Erro: ' + (j.detail || j.error || res.statusText));
            return;
        }
        window.prompt('COPIE AGORA a chave de integração (API). Não volta a ser mostrada:', j.api_key);
        loadPartnerApiAdmin();
    } catch (e) {
        alert('Falha: ' + (e.message || e));
    }
};

window.forcePartnerOfflineNow = async function (partnerProfileId) {
    if (!confirm('Forçar OFFLINE de todos os chips deste parceiro agora?')) return;
    const { data: { session } } = await db.auth.getSession();
    if (!session) {
        alert('Sessão expirada.');
        return;
    }
    try {
        const res = await fetch(`${ADMIN_BACKEND_URL}/api/admin/partners/${partnerProfileId}/chips/force-offline`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${session.access_token}` }
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok || !j.ok) {
            alert('Erro: ' + (j.detail || j.error || res.statusText));
            return;
        }
        alert(`Limpeza concluída: ${j.chips_offline || 0} chips OFFLINE.`);
        loadPolos();
        loadChips();
    } catch (e) {
        alert('Falha: ' + (e.message || e));
    }
};

init();
