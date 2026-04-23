/* global poloWorker */

const loginPane = document.getElementById('login-pane');
const appPane = document.getElementById('app-pane');
const statusChip = document.getElementById('status-chip');
const modemTableBody = document.getElementById('modem-table-body');
const lastSyncEl = document.getElementById('last-sync');
const ccidFileInput = document.getElementById('ccid-file-input');
const ccidImportStatus = document.getElementById('ccid-import-status');
const ccidFileInputLogin = document.getElementById('ccid-file-input-login');
const ccidImportStatusLogin = document.getElementById('ccid-import-status-login');
const appVersionLabel = document.getElementById('app-version-label');
const updateBanner = document.getElementById('update-banner');
const btnUpdateCheck = document.getElementById('btn-update-check');
const btnUpdateDownload = document.getElementById('btn-update-download');

const numModalBackdrop = document.getElementById('num-modal-backdrop');
const numModalLed = document.getElementById('num-modal-led');
const numModalHeadline = document.getElementById('num-modal-headline');
const numModalSub = document.getElementById('num-modal-sub');
const numModalClose = document.getElementById('num-modal-close');
const actTbody = document.getElementById('act-tbody');
const actCount = document.getElementById('act-count');
const actErr = document.getElementById('act-err');
const numSideMeta = document.getElementById('num-side-meta');

let refreshTimer = null;
let lastModalPorta = null;

function setStatus(text, ok) {
  statusChip.textContent = text;
  statusChip.className = ok ? 'status-chip ok' : 'status-chip';
}

function showLogin(show) {
  loginPane.style.display = show ? 'block' : 'none';
  appPane.style.display = show ? 'none' : 'block';
}

function fmtDate(v) {
  if (!v) return '—';
  try {
    return new Date(v).toLocaleString('pt-BR');
  } catch {
    return '—';
  }
}

function fmtShortId(uuid) {
  if (!uuid) return '—';
  const s = String(uuid);
  if (s.length > 20) return `${s.slice(0, 8)}…${s.slice(-4)}`;
  return s;
}

function labelActivationStatus(status) {
  const m = {
    received: 'Sucesso',
    cancelled: 'Cancelado',
    expired: 'Expirado',
    waiting: 'A aguardar',
    pending: 'Pendente'
  };
  return m[status] || status || '—';
}

function rowClassForAct(status) {
  if (status === 'received') return 'act-ok';
  if (status === 'cancelled' || status === 'expired') return 'act-bad';
  return 'act-pending';
}

function applyCcidTextToStatusEl(el, status) {
  if (!el) return;
  const n = Number(status?.ccidUserPairsCount || 0);
  const at = status?.ccidLastImportAt;
  el.classList.remove('ok', 'err');
  if (n > 0) {
    const when = at
      ? new Date(at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
      : '';
    el.textContent = when
      ? `Lista: ${n} par(es) · ${when}`
      : `Lista: ${n} par(es).`;
    el.classList.add('ok');
  } else {
    el.textContent = 'Nenhum TXT. Use «Importar lista» para mapear CCID → número.';
  }
}

function updateCcidImportBanner(status) {
  applyCcidTextToStatusEl(ccidImportStatus, status);
  applyCcidTextToStatusEl(ccidImportStatusLogin, status);
}

function parsePairsFromTxt(rawText) {
  const out = [];
  const lines = String(rawText || '').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    let parts;
    if (line.includes('\t')) parts = line.split(/\t/).map((s) => s.trim()).filter(Boolean);
    else if (line.includes('|')) parts = line.split('|').map((s) => s.trim()).filter(Boolean);
    else if (line.includes(';')) parts = line.split(';').map((s) => s.trim()).filter(Boolean);
    else if (line.includes(',')) parts = line.split(',').map((s) => s.trim()).filter(Boolean);
    else {
      const nums = line.match(/\d{8,}/g);
      if (nums && nums.length >= 2) parts = [nums[0], nums[1]];
      else continue;
    }
    if (!parts || parts.length < 2) continue;
    const a = String(parts[0] || '').replace(/\D/g, '');
    const b = String(parts[1] || '').replace(/\D/g, '');
    if (!a || !b) continue;
    const ccid = a.length >= b.length ? a : b;
    const numero = a.length >= b.length ? b : a;
    if (ccid.length >= 10 && numero.length >= 8) out.push([ccid, numero]);
  }
  return out;
}

function parsePairsFromJson(rawText) {
  const json = JSON.parse(String(rawText || '{}'));
  const out = [];
  if (Array.isArray(json)) {
    json.forEach((row) => {
      if (!row || typeof row !== 'object') return;
      const ccidRaw = row.CCID || row.ccid || row.chip || row.iccid || '';
      const numRaw = row.NUMERO || row.numero || row.number || row.phone || '';
      const ccid = String(ccidRaw).replace(/\D/g, '');
      const numero = String(numRaw).replace(/\D/g, '');
      if (ccid.length >= 10 && numero.length >= 8) out.push([ccid, numero]);
    });
    return out;
  }
  if (json && typeof json === 'object') {
    Object.entries(json).forEach(([k, v]) => {
      const ccid = String(k).replace(/\D/g, '');
      const numero = String(v == null ? '' : v).replace(/\D/g, '');
      if (ccid.length >= 10 && numero.length >= 8) out.push([ccid, numero]);
    });
  }
  return out;
}

function normalizeImportToWorkerText(fileName, rawText) {
  const lower = String(fileName || '').toLowerCase();
  let pairs = [];
  if (lower.endsWith('.json')) {
    pairs = parsePairsFromJson(rawText);
  } else {
    pairs = parsePairsFromTxt(rawText);
    if (!pairs.length) {
      try {
        pairs = parsePairsFromJson(rawText);
      } catch {
        /* ignore */
      }
    }
  }
  if (!pairs.length) {
    throw new Error('Nenhum par CCID+número válido encontrado. Use TXT/JSON no modelo indicado.');
  }
  // Entrega em formato canónico já limpo para manter compatibilidade com o core atual.
  return pairs.map(([ccid, numero]) => `${ccid};${numero}`).join('\n');
}

function downloadCcidModelFile() {
  const model = {
    '8955000000000000001': '5511999999999',
    '8955000000000000002': '5511888888888'
  };
  const blob = new Blob([`${JSON.stringify(model, null, 2)}\n`], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'modelo_ccid_numero.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function wireCcidImport({ btn, fileInput, statusEl }) {
  if (!btn || !fileInput || !statusEl) return;
  btn.addEventListener('click', () => {
    fileInput.value = '';
    fileInput.click();
  });
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    statusEl.classList.remove('ok', 'err');
    statusEl.textContent = 'A ler ficheiro…';
    try {
      const rawText = await file.text();
      const normalized = normalizeImportToWorkerText(file.name, rawText);
      const result = await poloWorker.ccidImportTxt(normalized);
      if (!result.ok) {
        statusEl.textContent = result.error || 'Falha na importação.';
        statusEl.classList.add('err');
        return;
      }
      statusEl.textContent = `OK: ${result.importedLines} linha(s) · ${result.userPairsTotal} par(es).`;
      statusEl.classList.add('ok');
      const st = await poloWorker.appStatus();
      updateCcidImportBanner(st);
      await setStatusAndCcid();
      await refreshModems();
    } catch (err) {
      statusEl.textContent = err.message || String(err);
      statusEl.classList.add('err');
    }
  });
}

async function setStatusAndCcid() {
  const status = await poloWorker.appStatus();
  setStatus(status.workerRunning ? 'CORE ONLINE' : 'CORE OFFLINE', status.workerRunning);
  updateCcidImportBanner(status);
}

async function refreshModems() {
  try {
    const rows = await poloWorker.modemRows();
    modemTableBody.innerHTML = '';
    rows.forEach((r) => {
      const tr = document.createElement('tr');
      const on = String(r.status || 'OFF').toUpperCase() === 'ON';
      tr.className = on ? 'modem-row--on' : 'modem-row--off';
      tr.dataset.porta = r.porta || '';
      tr.innerHTML = `
        <td>${r.porta || '—'}</td>
        <td>${r.numero || '—'}</td>
        <td>${r.operadora || '—'}</td>
        <td><span class="${on ? 'pill-on' : 'pill-off'}">${on ? 'ON' : 'OFF'}</span></td>
        <td>R$ ${Number(r.profit || 0).toFixed(2)}</td>
        <td>${fmtDate(r.lastActivationAt)}</td>
      `;
      tr.addEventListener('click', () => openNumberModal(r));
      modemTableBody.appendChild(tr);
    });
    if (!rows.length) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td colspan="6" style="text-align:center;opacity:.7;">Nenhum modem detectado ainda.</td>';
      modemTableBody.appendChild(tr);
    }
    lastSyncEl.textContent = `Última atualização: ${new Date().toLocaleTimeString('pt-BR')}`;
  } catch {
    lastSyncEl.textContent = 'Última atualização: em pausa (toque em «Atualizar monitoramento»).';
  }
}

async function openNumberModal(r) {
  if (!r || !r.porta) return;
  lastModalPorta = r.porta;
  if (numModalLed) {
    const on = String(r.status || 'OFF').toUpperCase() === 'ON';
    numModalLed.className = on ? 'led' : 'led led-off';
  }
  if (numModalHeadline) {
    const d = String(r.numero || '').replace(/\D/g, '');
    if (d.length >= 8) {
      const n = d.startsWith('55') ? d : `55${d}`;
      numModalHeadline.textContent = `Brasil +${n}`;
    } else {
      numModalHeadline.textContent = 'Detalhe do modem';
    }
  }
  if (numModalSub) numModalSub.textContent = `Porta ${r.porta} · clique fora para fechar`;
  if (numSideMeta) {
    numSideMeta.innerHTML = `
      <div><strong>Operadora</strong> ${(r.operadora && r.operadora !== '—') ? r.operadora : '—'}</div>
      <div><strong>Porta</strong> ${r.porta || '—'}</div>
      <div><strong>Lucro (monitor)</strong> R$ ${Number(r.profit || 0).toFixed(2)}</div>
    `;
  }
  if (actTbody) actTbody.innerHTML = '<tr><td colspan="5" style="text-align:center;opacity:0.7">A carregar…</td></tr>';
  if (actCount) actCount.textContent = 'Vendas / ativações (—)';
  if (actErr) { actErr.style.display = 'none'; actErr.textContent = ''; }
  if (numModalBackdrop) {
    numModalBackdrop.classList.add('open');
  }

  try {
    const res = await poloWorker.chipHistory(r.porta);
    if (!res || !res.ok) {
      const emsg = (res && res.error) || 'Falha ao carregar';
      if (actTbody) {
        actTbody.innerHTML = '';
      }
      if (actCount) actCount.textContent = 'Vendas / ativações (0)';
      if (actErr) {
        actErr.textContent = emsg + (res && res.status ? ` (${res.status})` : '');
        actErr.style.display = 'block';
      }
      return;
    }
    const list = res.activations || [];
    if (actCount) actCount.textContent = `Vendas / ativações (${list.length})`;
    if (!list.length) {
      if (actTbody) {
        actTbody.innerHTML = '<tr><td colspan="5" style="text-align:center;opacity:0.65">Sem ativações registadas (ou chip ainda não consta no servidor com esta porta).</td></tr>';
      }
      return;
    }
    if (actTbody) {
      const esc = (s) => String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      actTbody.innerHTML = list.map((a) => {
        const cls = rowClassForAct(a.status);
        const val = a.price != null ? `R$ ${Number(a.price).toFixed(2)}` : '—';
        const sn = esc(a.service_name || a.service || '—');
        return `<tr class="${cls}">
          <td><code style="font-size:11px">${esc(fmtShortId(a.id))}</code></td>
          <td>${sn}</td>
          <td>${val}</td>
          <td>${esc(labelActivationStatus(a.status))}</td>
          <td>${esc(fmtDate(a.created_at))}</td>
        </tr>`;
      }).join('');
    }
  } catch (err) {
    if (actTbody) actTbody.innerHTML = '';
    if (actErr) {
      actErr.textContent = err.message || String(err);
      actErr.style.display = 'block';
    }
  }
}

function closeNumberModal() {
  if (numModalBackdrop) numModalBackdrop.classList.remove('open');
  lastModalPorta = null;
}

if (numModalClose) numModalClose.addEventListener('click', closeNumberModal);
if (numModalBackdrop) {
  numModalBackdrop.addEventListener('click', () => closeNumberModal());
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeNumberModal();
});

function applyUpdateCheckResult(r, { quiet } = {}) {
  if (!updateBanner || !btnUpdateDownload) return;
  updateBanner.classList.remove('err');
  if (!r.ok) {
    if (!quiet) {
      updateBanner.textContent = 'Não foi possível verificar atualizações neste momento.';
      updateBanner.classList.add('err');
    }
    btnUpdateDownload.style.display = 'none';
    delete btnUpdateDownload.dataset.url;
    return;
  }
  if (r.updateAvailable) {
    updateBanner.textContent = `Nova versão ${r.remoteVersion} disponível (esta: ${r.localVersion}).`;
    updateBanner.style.color = '#f0d878';
    btnUpdateDownload.style.display = 'inline-block';
    btnUpdateDownload.dataset.url = r.downloadUrl || '';
    return;
  }
  updateBanner.style.color = '';
  btnUpdateDownload.style.display = 'none';
  delete btnUpdateDownload.dataset.url;
  if (!quiet) {
    updateBanner.textContent = `Está na última versão (${r.localVersion}).`;
  } else {
    updateBanner.textContent = '';
  }
}

async function checkUpdatesQuiet() {
  try {
    const r = await poloWorker.updatesCheck();
    applyUpdateCheckResult(r, { quiet: true });
  } catch {
    /* ignore */
  }
}

async function startDashboard() {
  showLogin(false);
  await setStatusAndCcid();
  await refreshModems();
  checkUpdatesQuiet();
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(refreshModems, 10000);
}

document.getElementById('btn-login').addEventListener('click', async () => {
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value.trim();
  const apiKey = document.getElementById('login-api-key').value.trim();
  const poloChave = document.getElementById('login-polo-key').value.trim();
  const backendUrl = document.getElementById('login-backend').value.trim();
  const rememberMe = document.getElementById('login-remember').checked;
  const msg = document.getElementById('login-msg');
  msg.textContent = 'A validar…';
  const result = await poloWorker.authLogin({ email, password, apiKey, rememberMe, poloChave, backendUrl });
  if (!result.ok) {
    msg.textContent = result.error || 'Falha no login.';
    return;
  }
  msg.textContent = '';
  await startDashboard();
});

document.getElementById('btn-logout').addEventListener('click', async () => {
  await poloWorker.appLogout();
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  closeNumberModal();
  showLogin(true);
  setStatus('CORE OFFLINE', false);
});

document.getElementById('btn-refresh').addEventListener('click', refreshModems);

if (btnUpdateCheck) {
  btnUpdateCheck.addEventListener('click', async () => {
    if (updateBanner) updateBanner.textContent = 'A verificar…';
    try {
      const r = await poloWorker.updatesCheck();
      applyUpdateCheckResult(r, { quiet: false });
    } catch {
      applyUpdateCheckResult({ ok: false }, { quiet: false });
    }
  });
}
if (btnUpdateDownload) {
  btnUpdateDownload.addEventListener('click', async () => {
    const url = btnUpdateDownload.dataset.url;
    if (!url) return;
    await poloWorker.updatesOpenDownload(url);
  });
}

wireCcidImport({
  btn: document.getElementById('btn-ccid-import'),
  fileInput: ccidFileInput,
  statusEl: ccidImportStatus
});
wireCcidImport({
  btn: document.getElementById('btn-ccid-import-login'),
  fileInput: ccidFileInputLogin,
  statusEl: ccidImportStatusLogin
});
const ccidModelLinkApp = document.getElementById('ccid-model-link-app');
const ccidModelLinkLogin = document.getElementById('ccid-model-link-login');
if (ccidModelLinkApp) {
  ccidModelLinkApp.addEventListener('click', (e) => {
    e.preventDefault();
    downloadCcidModelFile();
  });
}
if (ccidModelLinkLogin) {
  ccidModelLinkLogin.addEventListener('click', (e) => {
    e.preventDefault();
    downloadCcidModelFile();
  });
}

async function boot() {
  try {
    const meta = await poloWorker.appMeta();
    const v = meta && meta.version ? String(meta.version) : '—';
    if (appVersionLabel) appVersionLabel.textContent = `v${v}`;
    document.title = `FluxSMS Desktop v${v}`;
  } catch {
    if (appVersionLabel) appVersionLabel.textContent = 'v?';
  }
  try {
    const s0 = await poloWorker.appStatus();
    updateCcidImportBanner(s0);
  } catch {
    /* */
  }
  const saved = await poloWorker.authGetSaved();
  document.getElementById('login-email').value = saved.email || '';
  document.getElementById('login-password').value = saved.password || '';
  document.getElementById('login-api-key').value = saved.apiKey || '';
  document.getElementById('login-polo-key').value = '';
  document.getElementById('login-backend').value = 'https://fluxsms.com.br';
  document.getElementById('login-remember').checked = !!saved.rememberMe;
  showLogin(true);
  setStatus('CORE OFFLINE', false);
}

boot().catch((err) => {
  const el = document.getElementById('login-msg');
  if (el) el.textContent = err.message || String(err);
});
