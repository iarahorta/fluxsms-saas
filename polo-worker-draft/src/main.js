/**
 * Processo principal Electron — rascunho Polo Worker.
 * - Lista portas COM (serialport)
 * - Chamadas HTTP ao backend (axios) com Partner API Key
 */
const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');
const Store = require('electron-store');
const axios = require('axios');
const { SerialPort } = require('serialport');

const store = new Store({
  name: 'fluxsms-polo-worker',
  defaults: {
    backendUrl: 'https://fluxsms-staging-production.up.railway.app',
    partnerApiKey: '',
    poloChave: '',
    hardwareApiKey: ''
  }
});

function createWindow() {
  const win = new BrowserWindow({
    width: 920,
    height: 720,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.loadFile(path.join(__dirname, '..', 'index.html'));
}

function apiClient() {
  const baseURL = (store.get('backendUrl') || '').replace(/\/$/, '');
  const key = store.get('partnerApiKey') || '';
  return axios.create({
    baseURL,
    timeout: 20000,
    headers: {
      Authorization: key ? `Bearer ${key}` : '',
      'Content-Type': 'application/json'
    }
  });
}

ipcMain.handle('config:get', () => ({
  backendUrl: store.get('backendUrl'),
  partnerApiKey: store.get('partnerApiKey') ? '********' : '',
  poloChave: store.get('poloChave'),
  hasHardwareKey: !!store.get('hardwareApiKey')
}));

ipcMain.handle('config:set', (_e, payload) => {
  if (payload.backendUrl != null) store.set('backendUrl', String(payload.backendUrl).trim());
  if (payload.partnerApiKey != null) store.set('partnerApiKey', String(payload.partnerApiKey).trim());
  if (payload.poloChave != null) store.set('poloChave', String(payload.poloChave).trim());
  if (payload.hardwareApiKey != null) store.set('hardwareApiKey', String(payload.hardwareApiKey).trim());
  return { ok: true };
});

ipcMain.handle('serial:list', async () => {
  const list = await SerialPort.list();
  return list.map((p) => ({
    path: p.path,
    friendlyName: p.friendlyName || '',
    manufacturer: p.manufacturer || ''
  }));
});

ipcMain.handle('partner:registerChip', async (_e, { porta, numero, operadora }) => {
  const polo_chave = store.get('poloChave');
  if (!polo_chave) throw new Error('Defina a chave do polo.');
  const client = apiClient();
  const { data } = await client.post('/partner-api/chips', {
    polo_chave,
    porta: String(porta),
    numero: numero != null ? String(numero) : null,
    operadora: operadora || null
  });
  return data;
});

ipcMain.handle('partner:heartbeat', async () => {
  const polo_chave = store.get('poloChave');
  if (!polo_chave) throw new Error('Defina a chave do polo.');
  const client = apiClient();
  const { data } = await client.post('/partner-api/worker/heartbeat', { polo_chave });
  return data;
});

ipcMain.handle('partner:pendingActivations', async () => {
  const polo_chave = store.get('poloChave');
  if (!polo_chave) throw new Error('Defina a chave do polo.');
  const client = apiClient();
  const { data } = await client.get('/partner-api/worker/activations', {
    params: { polo_chave }
  });
  return data;
});

/** Entrega SMS ao backend (rota atual do FluxSMS — chave de hardware). */
ipcMain.handle('hardware:deliverSms', async (_e, { activation_id, sms_code, chip_porta }) => {
  const baseURL = (store.get('backendUrl') || '').replace(/\/$/, '');
  const hw = store.get('hardwareApiKey');
  if (!hw) throw new Error('Defina HARDWARE_API_KEY nas configurações.');
  const { data } = await axios.post(
    `${baseURL}/sms/deliver`,
    { activation_id, sms_code, chip_porta },
    {
      headers: {
        Authorization: `Bearer ${hw}`,
        'Content-Type': 'application/json'
      },
      timeout: 20000
    }
  );
  return data;
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
