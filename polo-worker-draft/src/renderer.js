/* global poloWorker */

function log(...args) {
  const el = document.getElementById('log');
  const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a, null, 2))).join(' ');
  el.textContent = `${new Date().toISOString()} ${line}\n` + el.textContent;
}

async function loadConfigIntoForm() {
  const c = await poloWorker.configGet();
  document.getElementById('backendUrl').value = c.backendUrl || '';
  document.getElementById('poloChave').value = c.poloChave || '';
  document.getElementById('partnerApiKey').placeholder = c.partnerApiKey || 'cole a Partner API Key';
  document.getElementById('hardwareApiKey').placeholder = c.hasHardwareKey ? '********' : 'cole HARDWARE_API_KEY';
}

document.getElementById('btnSaveConfig').addEventListener('click', async () => {
  try {
    await poloWorker.configSet({
      backendUrl: document.getElementById('backendUrl').value,
      partnerApiKey: document.getElementById('partnerApiKey').value,
      poloChave: document.getElementById('poloChave').value,
      hardwareApiKey: document.getElementById('hardwareApiKey').value
    });
    log('Configuração guardada.');
    await loadConfigIntoForm();
  } catch (e) {
    log('Erro ao guardar:', e.message || e);
  }
});

document.getElementById('btnListSerial').addEventListener('click', async () => {
  try {
    const ports = await poloWorker.serialList();
    const sel = document.getElementById('selPort');
    sel.innerHTML = '';
    ports.forEach((p) => {
      const opt = document.createElement('option');
      opt.value = p.path;
      opt.textContent = `${p.path} ${p.friendlyName ? '— ' + p.friendlyName : ''}`;
      sel.appendChild(opt);
    });
    log('Portas:', ports.length);
  } catch (e) {
    log('serial:list erro:', e.message || e);
  }
});

document.getElementById('selPort').addEventListener('change', () => {
  const sel = document.getElementById('selPort');
  if (sel.value) document.getElementById('chipPorta').value = sel.value;
});

document.getElementById('btnRegisterChip').addEventListener('click', async () => {
  try {
    const data = await poloWorker.registerChip({
      porta: document.getElementById('chipPorta').value,
      numero: document.getElementById('chipNumero').value || null,
      operadora: document.getElementById('chipOperadora').value || null
    });
    log('Chip registado:', data);
  } catch (e) {
    const msg = e.response?.data || e.message || e;
    log('registerChip erro:', msg);
    if (e.response?.status === 423) alert('Em Quarentena (WhatsApp): ' + (e.response?.data?.detail || ''));
  }
});

let pollTimer = null;
document.getElementById('btnTogglePoll').addEventListener('click', () => {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    log('Polling parado.');
    return;
  }
  const ms = Math.max(2000, parseInt(document.getElementById('pollMs').value, 10) || 5000);
  pollTimer = setInterval(async () => {
    try {
      await poloWorker.heartbeat();
      const pending = await poloWorker.pendingActivations();
      const n = (pending.activations || []).length;
      if (n > 0) log(`Fila: ${n} waiting`, pending.activations);
    } catch (e) {
      log('poll erro:', e.response?.data || e.message || e);
    }
  }, ms);
  log('Polling iniciado a cada', ms, 'ms');
});

document.getElementById('btnDeliver').addEventListener('click', async () => {
  try {
    const data = await poloWorker.deliverSms({
      activation_id: document.getElementById('actId').value,
      sms_code: document.getElementById('smsCode').value,
      chip_porta: document.getElementById('deliverPorta').value
    });
    log('Deliver:', data);
  } catch (e) {
    log('deliver erro:', e.response?.data || e.message || e);
  }
});

loadConfigIntoForm().catch((e) => log('init', e));
