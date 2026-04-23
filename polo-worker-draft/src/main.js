const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const { spawn } = require('child_process');
const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, shell, dialog } = require('electron');
const Store = require('electron-store');
const axios = require('axios');
const { SerialPort } = require('serialport');

let mainWindow = null;
let tray = null;
let workerProcess = null;
let workerRunning = false;
let workerShouldRestart = false;
let restartTimer = null;
let monitorPollTimer = null;
let heartbeatTimer = null;
let runtimeRows = {};
const runtimeLogs = [];
/** Último CCID visto por porta COM (logs do core) — cruza com lista importada .TXT */
const lastCcidByPort = {};

/** Ícone da app: chip dourado (marketing); fallback logo legado. */
function getAppIconPath() {
  const preferred = path.join(__dirname, '..', '..', 'marketing', 'assets', 'fluxsms-chip-dourado.png');
  const fallback = path.join(__dirname, '..', '..', 'assets', 'logo.png');
  return fs.existsSync(preferred) ? preferred : fallback;
}

/** Bandeja Windows: ícone ligeiramente redimensionado para ficar nítido em 16–32px. */
function getTrayIconImage() {
  const full = nativeImage.createFromPath(getAppIconPath());
  if (full.isEmpty()) return nativeImage.createEmpty();
  if (process.platform === 'win32') {
    const { width } = full.getSize();
    if (width > 64) {
      try {
        return full.resize({ width: 64, height: 64, quality: 'best' });
      } catch {
        return full;
      }
    }
  }
  return full;
}

function nowIso() {
  return new Date().toISOString();
}

function pushLog(message) {
  const line = `${nowIso()} ${message}`;
  runtimeLogs.unshift(line);
  while (runtimeLogs.length > 300) runtimeLogs.pop();
  /* Log só em memória/diagnóstico; não enviar à janela (parceiro não vê consola) */
}

let cachedFluxHwid = null;
function getFluxHwid() {
  if (cachedFluxHwid) return cachedFluxHwid;
  try {
    const { machineIdSync } = require('node-machine-id');
    cachedFluxHwid = crypto.createHash('sha256').update(`fluxsms|desktop|${machineIdSync()}`).digest('hex');
  } catch {
    cachedFluxHwid = crypto.createHash('sha256').update(`fluxsms|fallback|${os.hostname()}|${os.userInfo().username}`).digest('hex');
  }
  return cachedFluxHwid;
}

const store = new Store({
  name: 'fluxsms-desktop',
  defaults: {
    backendUrl: 'https://fluxsms.com.br',
    loginEmail: '',
    loginPassword: '',
    partnerApiKey: '',
    poloChave: '',
    rememberMe: false,
    ccidUserPairs: {}
  }
});

const CCID_NUMEROS_FILENAME = 'ccid_numeros.json';

function ccidNumerosPath() {
  return path.join(safeCorePath(), CCID_NUMEROS_FILENAME);
}

function readJsonCcidBase() {
  const p = ccidNumerosPath();
  if (!fs.existsSync(p)) return {};
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  } catch {
    return {};
  }
}

function syncCcidNumerosFileFromStore() {
  const user = store.get('ccidUserPairs') || {};
  const nUser = user && typeof user === 'object' && !Array.isArray(user) ? Object.keys(user).length : 0;
  const coreDir = safeCorePath();
  if (!fs.existsSync(coreDir)) return { written: false, totalKeys: 0 };
  const p = ccidNumerosPath();
  if (nUser === 0) {
    if (fs.existsSync(p)) {
      try {
        const o = JSON.parse(fs.readFileSync(p, 'utf8'));
        return { written: false, totalKeys: Object.keys(o && typeof o === 'object' ? o : {}).length };
      } catch {
        return { written: false, totalKeys: 0 };
      }
    }
    return { written: false, totalKeys: 0 };
  }
  const base = readJsonCcidBase();
  const merged = { ...base, ...user };
  fs.writeFileSync(p, JSON.stringify(merged, null, 2), 'utf8');
  return { written: true, totalKeys: Object.keys(merged).length };
}

function getMergedCcidMap() {
  const user = store.get('ccidUserPairs') || {};
  const base = readJsonCcidBase();
  const u = user && typeof user === 'object' && !Array.isArray(user) ? user : {};
  return { ...base, ...u };
}

function findPhoneInCcidMap(map, ccidRaw) {
  const c = String(ccidRaw).replace(/[^0-9A-Fa-f]/gi, '');
  if (c.length < 8) return null;
  const n = c.replace(/[^0-9]/g, '');
  if (n && map[n] != null) return map[n];
  for (const k of Object.keys(map)) {
    const kc = String(k).replace(/[^0-9]/g, '');
    if (n.length >= 8 && kc.length >= 8) {
      if (kc.endsWith(n.slice(-18)) || n.endsWith(kc.slice(-18))) return map[k];
    }
  }
  return null;
}

function enrichNumeroFromCoreLogLine(line) {
  const port = extractPort(line);
  if (port) {
    const m = String(line).match(/CCID:\s*([0-9A-Fa-f]+)/i);
    if (m) {
      const raw = m[1].replace(/[^0-9A-Fa-f]/gi, '');
      if (raw.length >= 10) lastCcidByPort[port] = raw;
    }
  }
  if (!port) return;
  const pats = [
    /Número \(via tabela\):\s*([+.\d][\d\s.()\-]*)/i,
    /Número \(phone book\):\s*([+.\d][\d\s.()\-]*)/i,
    /Número USSD:\s*([+.\d][\d\s.()\-]*)/i
  ];
  for (const p of pats) {
    const mm = String(line).match(p);
    if (mm && mm[1]) {
      const digits = String(mm[1]).replace(/\D/g, '');
      if (digits.length >= 8) {
        markRuntimePort(port, { numero: digits, status: 'ON' });
        return;
      }
    }
  }
  if (/CCID:\s*([0-9A-Fa-f]+)/i.test(line)) {
    const m = String(line).match(/CCID:\s*([0-9A-Fa-f]+)/i);
    if (m) {
      const map = getMergedCcidMap();
      const phone = findPhoneInCcidMap(map, m[1]);
      if (phone) {
        const d = String(phone).replace(/\D/g, '');
        if (d.length >= 8) markRuntimePort(port, { numero: d, status: 'ON' });
      }
    }
  }
}

function parseCcidTxtToMap(rawText) {
  const out = {};
  const lines = String(rawText || '').split(/\r?\n/);
  for (const raw of lines) {
    let line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    let parts;
    if (line.includes('\t')) parts = line.split(/\t/).map((s) => s.trim()).filter(Boolean);
    else if (line.includes('|')) parts = line.split('|').map((s) => s.trim()).filter(Boolean);
    else if (line.includes(';')) parts = line.split(';').map((s) => s.trim()).filter(Boolean);
    else if (line.includes(',')) parts = line.split(',').map((s) => s.trim()).filter(Boolean);
    else {
      const nums = line.match(/\d{10,}/g);
      if (nums && nums.length >= 2) parts = [nums[0], nums[1]];
      else continue;
    }
    if (!parts || parts.length < 2) continue;
    const d1 = String(parts[0]).replace(/\D/g, '');
    const d2 = String(parts[1]).replace(/\D/g, '');
    if (!d1 || !d2) continue;
    let ccid = d1.length >= d2.length ? d1 : d2;
    let phone = d1.length >= d2.length ? d2 : d1;
    if (phone.length > 15 && ccid.length <= 15) {
      const t = ccid;
      ccid = phone;
      phone = t;
    }
    if (ccid.length < 10 || phone.length < 8) continue;
    out[ccid] = phone;
  }
  return out;
}

function restartWorkerForCcidReload() {
  const was = workerRunning;
  if (was) stopWorker();
  workerShouldRestart = true;
  if (was) {
    const r = startWorker();
    if (!r.ok) pushLog(`[WARN] Reinício do core após lista CCID: ${r.error || 'falha'}`);
    else pushLog('[SYSTEM] Core reiniciado para carregar ccid_numeros.json atualizado.');
  }
}

function safeCorePath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'core-v7.1');
  }
  return path.join(__dirname, '..', 'core-v7.1');
}

function partnerRequestHeaders() {
  const key = String(store.get('partnerApiKey') || '').trim();
  const hwid = getFluxHwid();
  const h = {
    'Content-Type': 'application/json',
    'X-Flux-Hwid': hwid
  };
  if (key) {
    h.Authorization = `Bearer ${key}`;
    h['X-API-Key'] = key;
  }
  return h;
}

function apiClient() {
  const baseURL = String(store.get('backendUrl') || '').replace(/\/$/, '');
  return axios.create({
    baseURL,
    timeout: 20000,
    headers: partnerRequestHeaders()
  });
}

function sanitizeWorkerLine(raw) {
  let line = String(raw || '');
  if (!line.trim()) return '';
  line = line.replace(/TEXTO COMPLETO:.*/gi, 'TEXTO COMPLETO: [oculto]');
  line = line.replace(/D[IÍ]GITOS? DETECTADOS:.*/gi, 'DIGITOS DETECTADOS: [oculto]');
  line = line.replace(/C[ÓO]DIGO CANDIDATO:.*/gi, 'CODIGO CANDIDATO: [oculto]');
  line = line.replace(/\b\d{4,8}\b/g, '****');
  return line;
}

function extractPort(line) {
  const m = String(line || '').match(/\bCOM\d+\b/i);
  return m ? m[0].toUpperCase() : null;
}

function markRuntimePort(port, patch) {
  if (!port) return;
  runtimeRows[port] = {
    porta: port,
    numero: runtimeRows[port]?.numero || '—',
    operadora: runtimeRows[port]?.operadora || '—',
    status: runtimeRows[port]?.status || 'OFF',
    profit: runtimeRows[port]?.profit || 0,
    lastActivationAt: runtimeRows[port]?.lastActivationAt || null,
    ...patch
  };
}

function updatePortStatusFromLog(line) {
  const port = extractPort(line);
  if (!port) return;
  if (/ATIVANDO ESCUTA|MONITORAMENTO ATIVO|INICIANDO MONITORAMENTO/i.test(line)) {
    markRuntimePort(port, { status: 'ON' });
    return;
  }
  if (/ERRO CR[IÍ]TICO|FALHA AO ABRIR PORTA|ENCERRADO/i.test(line)) {
    markRuntimePort(port, { status: 'OFF' });
  }
}

function ensureCoreEnv() {
  const coreDir = safeCorePath();
  const envPath = path.join(coreDir, '.env');
  let envRaw = '';
  if (fs.existsSync(envPath)) {
    envRaw = fs.readFileSync(envPath, 'utf8');
  }
  const backendUrl = String(store.get('backendUrl') || '').trim();
  const poloKey = String(store.get('poloChave') || '').trim();
  const setVar = (name, value) => {
    if (!value) return;
    const rgx = new RegExp(`^${name}=.*$`, 'm');
    if (rgx.test(envRaw)) {
      envRaw = envRaw.replace(rgx, `${name}=${value}`);
    } else {
      envRaw += `${envRaw.endsWith('\n') || !envRaw ? '' : '\n'}${name}=${value}\n`;
    }
  };
  setVar('BACKEND_URL', backendUrl);
  setVar('POLO_KEY', poloKey);
  fs.writeFileSync(envPath, envRaw || '\n', 'utf8');
}

function clearMonitorPoll() {
  if (monitorPollTimer) {
    clearInterval(monitorPollTimer);
    monitorPollTimer = null;
  }
}

function clearHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

async function sendHeartbeat() {
  try {
    const polo_chave = String(store.get('poloChave') || '').trim();
    if (!polo_chave) return;
    await apiClient().post('/partner-api/worker/heartbeat', { polo_chave });
  } catch (err) {
    pushLog(`[WARN] heartbeat falhou: ${err.message || err}`);
  }
}

async function sendGracefulShutdown() {
  try {
    const polo_chave = String(store.get('poloChave') || '').trim();
    if (!polo_chave) return;
    await apiClient().post('/partner-api/worker/shutdown', { polo_chave });
    pushLog('[SYSTEM] Graceful shutdown enviado (chips OFFLINE).');
  } catch (err) {
    pushLog(`[WARN] graceful shutdown falhou: ${err.message || err}`);
  }
}

async function pollPendingActivations() {
  try {
    const polo_chave = String(store.get('poloChave') || '').trim();
    if (!polo_chave) return;
    const client = apiClient();
    const { data } = await client.get('/partner-api/worker/activations', {
      params: { polo_chave }
    });
    const rows = data.activations || [];
    rows.forEach((r) => {
      const port = String(r.chip_porta || '').toUpperCase();
      if (!port) return;
      markRuntimePort(port, {
        numero: r.chip_numero || runtimeRows[port]?.numero || '—',
        status: 'ON',
        lastActivationAt: r.created_at || runtimeRows[port]?.lastActivationAt || null,
        profit: Number((runtimeRows[port]?.profit || 0) + Number(r.price || 0))
      });
      pushLog(`[REQUEST] SMS em processamento: serviço=${r.service_name || r.service || 'N/A'} porta=${port} ativação=${String(r.id || '').slice(0, 8)}...`);
    });
  } catch (err) {
    pushLog(`[WARN] Falha no polling de requisições: ${err.message || err}`);
  }
}

function startMonitorPoll() {
  clearMonitorPoll();
  monitorPollTimer = setInterval(pollPendingActivations, 10000);
  pollPendingActivations().catch(() => { });
}

function startHeartbeat() {
  clearHeartbeat();
  heartbeatTimer = setInterval(sendHeartbeat, 30000);
  sendHeartbeat().catch(() => { });
}

function stopWorker() {
  workerShouldRestart = false;
  clearMonitorPoll();
  clearHeartbeat();
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  if (workerProcess && !workerProcess.killed) {
    workerProcess.kill();
  }
  workerProcess = null;
  workerRunning = false;
  for (const k of Object.keys(lastCcidByPort)) delete lastCcidByPort[k];
  sendGracefulShutdown().catch(() => { });
  pushLog('[SYSTEM] Core V7.1 parado.');
}

function spawnWorkerWith(cmd, args, cwd) {
  // Um único processo filho (Core V7.1) reutilizado — sem reelevar UAC a cada leitura COM
  return spawn(cmd, args, {
    cwd,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false
  });
}

function startWorker() {
  if (workerRunning) return { ok: true, alreadyRunning: true };
  const coreDir = safeCorePath();
  if (!fs.existsSync(path.join(coreDir, 'main.py'))) {
    return { ok: false, error: 'Core V7.1 não encontrado (main.py ausente).' };
  }
  ensureCoreEnv();
  try {
    syncCcidNumerosFileFromStore();
  } catch (err) {
    pushLog(`[WARN] ccid_numeros sync: ${err.message || err}`);
  }
  workerShouldRestart = true;

  let child = null;
  try {
    child = spawnWorkerWith('py', ['-3', 'main.py'], coreDir);
  } catch (_) { }
  if (!child || child.exitCode != null) {
    try {
      child = spawnWorkerWith('python', ['main.py'], coreDir);
    } catch (err) {
      return { ok: false, error: `Falha ao iniciar Python: ${err.message || err}` };
    }
  }

  workerProcess = child;
  workerRunning = true;
  pushLog('[SYSTEM] Core V7.1 iniciado (serial/sync preservados).');
  startMonitorPoll();
  startHeartbeat();

  child.stdout.on('data', (buff) => {
    String(buff).split(/\r?\n/).forEach((line) => {
      const sanitized = sanitizeWorkerLine(line);
      if (!sanitized) return;
      updatePortStatusFromLog(sanitized);
      enrichNumeroFromCoreLogLine(sanitized);
      pushLog(`[CORE] ${sanitized}`);
    });
  });
  child.stderr.on('data', (buff) => {
    String(buff).split(/\r?\n/).forEach((line) => {
      const sanitized = sanitizeWorkerLine(line);
      if (!sanitized) return;
      updatePortStatusFromLog(sanitized);
      enrichNumeroFromCoreLogLine(sanitized);
      pushLog(`[CORE-ERR] ${sanitized}`);
    });
  });

  child.on('close', (code) => {
    workerRunning = false;
    workerProcess = null;
    clearMonitorPoll();
    clearHeartbeat();
    pushLog(`[SYSTEM] Core V7.1 encerrou (code=${code}).`);
    if (workerShouldRestart) {
      pushLog('[SYSTEM] Reconexão automática ativada. Reiniciando em 5s...');
      restartTimer = setTimeout(() => {
        restartTimer = null;
        startWorker();
      }, 5000);
    }
  });

  return { ok: true };
}

function semverCompare(a, b) {
  const norm = (v) => String(v || '0').replace(/^v/i, '').split('.').map((x) => parseInt(x, 10) || 0);
  const pa = norm(a);
  const pb = norm(b);
  const n = Math.max(pa.length, pb.length, 3);
  for (let i = 0; i < n; i++) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

async function fetchUpdateInfo() {
  const base = String(store.get('backendUrl') || 'https://fluxsms.com.br').replace(/\/$/, '');
  let res;
  try {
    res = await axios.get(`${base}/download/desktop-update.json`, { timeout: 15000, validateStatus: () => true });
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
  if (res.status !== 200) {
    return { ok: false, error: `Não foi possível ler a versão no site (${res.status}).` };
  }
  const data = res.data;
  if (!data || typeof data !== 'object') {
    return { ok: false, error: 'Resposta inválida do servidor.' };
  }
  const remote = String(data.version || '').trim();
  const url = String(data.url || '').trim() || `${base}/download/FluxSMS.0.4.2.exe`;
  const notes = String(data.notes || '').trim();
  if (!remote) {
    return { ok: false, error: 'Ficheiro desktop-update.json sem campo «version».' };
  }
  const local = app.getVersion();
  const cmp = semverCompare(remote, local);
  return {
    ok: true,
    localVersion: local,
    remoteVersion: remote,
    updateAvailable: cmp === 1,
    downloadUrl: url,
    notes
  };
}

async function runUpdateCheckFromTray() {
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  try {
    const r = await fetchUpdateInfo();
    if (!r.ok) {
      await dialog.showMessageBox(win, { type: 'warning', title: 'FluxSMS', message: r.error || 'Falha ao verificar.' });
      return;
    }
    if (r.updateAvailable) {
      const { response } = await dialog.showMessageBox(win, {
        type: 'info',
        buttons: ['Baixar agora', 'Depois'],
        defaultId: 0,
        cancelId: 1,
        title: 'Atualização disponível',
        message: `Nova versão ${r.remoteVersion} disponível.`,
        detail: `Esta instalação: ${r.localVersion}.\n\n${r.notes ? `${r.notes}\n\n` : ''}O browser vai abrir para descarregar o instalador.`
      });
      if (response === 0) await shell.openExternal(r.downloadUrl);
    } else {
      await dialog.showMessageBox(win, {
        type: 'info',
        title: 'FluxSMS',
        message: `Está na última versão (${r.localVersion}).`
      });
    }
  } catch (e) {
    await dialog.showMessageBox(win, { type: 'error', title: 'FluxSMS', message: e.message || String(e) });
  }
}

function createWindow() {
  const ver = app.getVersion();
  mainWindow = new BrowserWindow({
    width: 1220,
    height: 780,
    minWidth: 980,
    minHeight: 640,
    autoHideMenuBar: true,
    title: `FluxSMS Desktop v${ver}`,
    icon: getAppIconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      devTools: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'index.html'));
  mainWindow.once('ready-to-show', () => {
    const v = app.getVersion();
    try {
      mainWindow.setTitle(`FluxSMS Desktop v${v}`);
    } catch {
      /* ignore */
    }
  });
  mainWindow.on('minimize', () => {
    pushLog('[SYSTEM] App minimizado. Core permanece ONLINE em background.');
  });
  mainWindow.on('close', (event) => {
    if (!app.isQuiting) {
      event.preventDefault();
      mainWindow.hide();
      pushLog('[SYSTEM] Janela oculta. App segue em background.');
    }
  });

  mainWindow.webContents.on('before-input-event', (event, input) => {
    const key = String(input.key || '').toUpperCase();
    const blocked = key === 'F12' ||
      ((input.control || input.meta) && input.shift && ['I', 'J', 'C'].includes(key)) ||
      ((input.control || input.meta) && key === 'U');
    if (blocked) {
      event.preventDefault();
    }
  });
  mainWindow.webContents.on('context-menu', (e) => e.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

function setupTray() {
  const trayIcon = getTrayIconImage();
  tray = new Tray(trayIcon.isEmpty() ? nativeImage.createEmpty() : trayIcon);
  tray.setToolTip(`FluxSMS Desktop v${app.getVersion()}`);
  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: 'Abrir FluxSMS',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      }
    },
    {
      label: 'Verificar atualização…',
      click: () => {
        runUpdateCheckFromTray().catch(() => { });
      }
    },
    {
      label: 'Sair',
      click: () => {
        app.isQuiting = true;
        stopWorker();
        app.quit();
      }
    }
  ]));
}

ipcMain.handle('app:meta', () => ({
  name: 'FluxSMS Desktop',
  version: app.getVersion()
}));

ipcMain.handle('auth:getSaved', () => ({
  email: String(store.get('loginEmail') || ''),
  password: String(store.get('loginPassword') || ''),
  apiKey: String(store.get('partnerApiKey') || ''),
  rememberMe: !!store.get('rememberMe')
}));

ipcMain.handle('auth:login', async (_e, payload) => {
  const email = String(payload.email || '').trim().toLowerCase();
  const password = String(payload.password || '').trim();
  const apiKey = String(payload.apiKey || '').trim();
  const rememberMe = !!payload.rememberMe;
  const poloChave = String(payload.poloChave || '').trim();
  const backendUrl = String(payload.backendUrl || '').trim() || String(store.get('backendUrl') || '');
  if (!email || !password || !apiKey || !poloChave) {
    return { ok: false, error: 'Preencha e-mail, senha, chave de integração e CHAVE DO PARCEIRO.' };
  }

  store.set('backendUrl', backendUrl.replace(/\/$/, ''));
  store.set('partnerApiKey', apiKey);
  store.set('poloChave', poloChave);
  store.set('rememberMe', rememberMe);
  if (rememberMe) {
    store.set('loginEmail', email);
    store.set('loginPassword', password);
  } else {
    store.set('loginEmail', '');
    store.set('loginPassword', '');
  }

  try {
    await apiClient().get('/partner-api/health');
    const workerResult = startWorker();
    if (!workerResult.ok) return workerResult;
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `Falha na autenticação da API: ${err.response?.data?.error || err.message}` };
  }
});

ipcMain.handle('app:status', () => {
  const userPairs = store.get('ccidUserPairs') || {};
  const nUser = Object.keys(userPairs).length;
  return {
    workerRunning,
    ccidUserPairsCount: nUser,
    ccidLastImportAt: store.get('ccidLastImportAt') || null
  };
});

ipcMain.handle('updates:check', async () => fetchUpdateInfo());

ipcMain.handle('updates:openDownload', async (_e, url) => {
  const u = String(url || '').trim();
  if (!u) return { ok: false, error: 'URL em falta.' };
  try {
    await shell.openExternal(u);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
});

ipcMain.handle('ccid:importTxt', async (_e, payload) => {
  const rawText = String(payload?.rawText || '');
  if (!rawText.trim()) {
    return { ok: false, error: 'Arquivo vazio ou inválido.' };
  }
  const parsed = parseCcidTxtToMap(rawText);
  const nNew = Object.keys(parsed).length;
  if (!nNew) {
    return { ok: false, error: 'Nenhum par CCID+número reconhecido. Use uma linha por par (separador: tab, vírgula, ; ou |).' };
  }
  const prev = store.get('ccidUserPairs') || {};
  const mergedUser = { ...prev, ...parsed };
  store.set('ccidUserPairs', mergedUser);
  store.set('ccidLastImportAt', nowIso());
  let totalKeys = 0;
  try {
    const sync = syncCcidNumerosFileFromStore();
    totalKeys = sync.totalKeys;
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
  restartWorkerForCcidReload();
  return {
    ok: true,
    importedLines: nNew,
    userPairsTotal: Object.keys(mergedUser).length,
    fileTotalKeys: totalKeys
  };
});

ipcMain.handle('app:logout', () => {
  stopWorker();
  return { ok: true };
});

ipcMain.handle('serial:list', async () => {
  const list = await SerialPort.list();
  return list.map((p) => ({
    porta: p.path,
    numero: runtimeRows[p.path?.toUpperCase?.()]?.numero || '—',
    operadora: runtimeRows[p.path?.toUpperCase?.()]?.operadora || '—',
    status: runtimeRows[p.path?.toUpperCase?.()]?.status || 'OFF',
    profit: Number(runtimeRows[p.path?.toUpperCase?.()]?.profit || 0),
    lastActivationAt: runtimeRows[p.path?.toUpperCase?.()]?.lastActivationAt || null
  }));
});

ipcMain.handle('partner:modems', async () => {
  const list = await SerialPort.list();
  const mergedCcid = getMergedCcidMap();
  const base = list.map((p) => {
    const up = p.path?.toUpperCase?.() || '';
    let numero = runtimeRows[up]?.numero || '—';
    if (numero === '—' && lastCcidByPort[up]) {
      const ph = findPhoneInCcidMap(mergedCcid, lastCcidByPort[up]);
      if (ph) numero = String(ph).replace(/\D/g, '');
    }
    return {
      porta: p.path,
      numero,
      operadora: runtimeRows[up]?.operadora || '—',
      status: runtimeRows[up]?.status || 'OFF',
      profit: Number(runtimeRows[up]?.profit || 0),
      lastActivationAt: runtimeRows[up]?.lastActivationAt || null
    };
  });
  const map = Object.fromEntries(base.map((r) => [String(r.porta || '').toUpperCase(), r]));
  try {
    const polo_chave = String(store.get('poloChave') || '').trim();
    const client = apiClient();
    const { data } = await client.get('/partner-api/worker/activations', { params: { polo_chave } });
    (data.activations || []).forEach((a) => {
      const port = String(a.chip_porta || '').toUpperCase();
      if (!port) return;
      if (!map[port]) {
        map[port] = {
          porta: port,
          numero: a.chip_numero || '—',
          operadora: '—',
          status: 'ON',
          profit: 0,
          lastActivationAt: a.created_at || null
        };
      }
      map[port].numero = a.chip_numero || map[port].numero;
      map[port].status = 'ON';
      map[port].profit = Number(map[port].profit || 0) + Number(a.price || 0);
      map[port].lastActivationAt = a.created_at || map[port].lastActivationAt;
    });
  } catch (err) {
    pushLog(`[WARN] Monitor API indisponível: ${err.message || err}`);
  }
  try {
    const polo_chave2 = String(store.get('poloChave') || '').trim();
    const { data: chipPayload } = await apiClient().get('/partner-api/worker/chips', { params: { polo_chave: polo_chave2 } });
    if (chipPayload && chipPayload.ok) {
      (chipPayload.chips || []).forEach((c) => {
        const port = String(c.porta || '').toUpperCase();
        if (!port) return;
        if (!map[port]) {
          map[port] = {
            porta: c.porta || port,
            numero: '—',
            operadora: c.operadora || '—',
            status: 'OFF',
            profit: 0,
            lastActivationAt: null
          };
        }
        const rawNum = c.numero != null ? String(c.numero).trim() : '';
        if (rawNum && rawNum !== '—') {
          const digits = rawNum.replace(/\D/g, '');
          if (digits.length >= 8 && (map[port].numero === '—' || !map[port].numero)) {
            map[port].numero = digits;
          }
        }
        if (c.operadora && String(c.operadora).trim() && map[port].operadora === '—') {
          map[port].operadora = String(c.operadora);
        }
      });
    }
  } catch (err2) {
    pushLog(`[WARN] Chips API indisponível: ${err2.message || err2}`);
  }
  return Object.values(map).sort((a, b) => String(a.porta).localeCompare(String(b.porta)));
});

ipcMain.handle('partner:chipHistory', async (_e, { porta } = {}) => {
  const poloChave = String(store.get('poloChave') || '').trim();
  const port = String(porta || '').trim();
  if (!port) {
    return { ok: false, error: 'Porta inválida.' };
  }
  const client = apiClient();
  try {
    const { data, status } = await client.get('/partner-api/worker/chip-activations', {
      params: { polo_chave: poloChave, porta: port }
    });
    if (data && data.ok) return { ok: true, ...data };
    return { ok: false, error: data?.error || 'resposta inválida', status };
  } catch (err) {
    const st = err.response?.status;
    const body = err.response?.data;
    const code = body?.error || err.message;
    if (st === 403) {
      return {
        ok: false,
        error: body?.detail
          || body?.error
          || (body?.ip ? `IP não autorizado (${body.ip})` : 'Acesso negado (403). Verifique a chave de integração, CHAVE DO PARCEIRO e rede (VPN/IP).'),
        status: st
      };
    }
    if (st === 401) {
      return { ok: false, error: 'Chave de integração inválida ou expirada (401).', status: st };
    }
    return { ok: false, error: code, status: st, detail: body };
  }
});

app.whenReady().then(() => {
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.fluxsms.poloworker');
  }
  Menu.setApplicationMenu(null);
  createWindow();
  setupTray();
});

app.on('before-quit', () => {
  app.isQuiting = true;
  stopWorker();
});

app.on('window-all-closed', (event) => {
  event.preventDefault();
});
