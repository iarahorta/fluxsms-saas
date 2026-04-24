const axios = require('axios');

function baseUrl() {
    return String(process.env.NEXUSPAG_BASE_URL || 'https://nexuspag.com').replace(/\/$/, '');
}

function apiKey() {
    return String(process.env.NEXUSPAG_API_KEY || process.env.NEXUS_PAY_API_KEY || '').trim();
}

function nexusAxios() {
    const key = apiKey();
    if (!key) {
        throw new Error('NEXUSPAG_API_KEY ausente no ambiente');
    }
    return axios.create({
        baseURL: baseUrl(),
        timeout: 20000,
        headers: {
            'x-api-key': key,
            'Content-Type': 'application/json'
        }
    });
}

function pickFirst(obj, paths) {
    for (const p of paths) {
        const parts = p.split('.');
        let cur = obj;
        let ok = true;
        for (const part of parts) {
            if (cur == null || typeof cur !== 'object') {
                ok = false;
                break;
            }
            cur = cur[part];
        }
        if (ok && cur !== undefined && cur !== null && cur !== '') return cur;
    }
    return null;
}

/**
 * Cria cobrança PIX na NexusPag (tenta payloads comuns até um funcionar).
 * Nunca logar a API key.
 */
async function createPixCharge({ amountBrl, externalId, webhookUrl, description }) {
    const client = nexusAxios();
    const amount = Number(amountBrl);
    if (!Number.isFinite(amount) || amount <= 0) {
        throw new Error('Valor inválido');
    }

    const payloads = [
        {
            amount,
            external_id: externalId,
            webhook_url: webhookUrl,
            description: description || `FluxSMS recarga R$ ${amount.toFixed(2)}`
        },
        {
            value: amount,
            external_id: externalId,
            webhook_url: webhookUrl,
            description: description || `FluxSMS recarga R$ ${amount.toFixed(2)}`
        },
        {
            amount_cents: Math.round(amount * 100),
            external_id: externalId,
            webhook_url: webhookUrl,
            description: description || `FluxSMS recarga R$ ${amount.toFixed(2)}`
        }
    ];

    let lastErr = null;
    for (const body of payloads) {
        try {
            const res = await client.post('/api/pix/create', body, { validateStatus: () => true });
            if (res.status >= 200 && res.status < 300) {
                return { ok: true, status: res.status, data: res.data, bodyUsed: body };
            }
            lastErr = new Error(`HTTP ${res.status}: ${typeof res.data === 'string' ? res.data : JSON.stringify(res.data)}`);
        } catch (e) {
            lastErr = e;
        }
    }
    throw lastErr || new Error('Falha ao criar PIX na NexusPag');
}

async function getPixCharge(chargeId) {
    const id = String(chargeId || '').trim();
    if (!id) throw new Error('charge_id_vazio');
    const client = nexusAxios();
    const res = await client.get(`/api/pix/${encodeURIComponent(id)}`, { validateStatus: () => true });
    return { status: res.status, data: res.data };
}

function extractChargeIdFromWebhookBody(body) {
    if (!body || typeof body !== 'object') return null;
    const direct = pickFirst(body, [
        'id',
        'charge_id',
        'transaction_id',
        'data.id',
        'data.charge_id',
        'payload.id',
        'payload.charge_id',
        'pix.id',
        'payment.id',
        'payment.charge_id'
    ]);
    if (direct) return String(direct);
    return null;
}

/** Nexus pode enviar event (ex.: payment.confirmed) sem status no mesmo formato da API GET. */
function extractPaidFromWebhookBody(body) {
    if (!body || typeof body !== 'object') return false;
    const ev = String(
        pickFirst(body, ['event', 'type', 'action', 'status', 'data.event', 'payload.event']) || ''
    ).toLowerCase();
    if (ev.includes('payment.confirmed') || ev.includes('pix.confirmed') || ev.includes('charge.paid')) {
        return true;
    }
    const nested = String(
        pickFirst(body, ['data.status', 'payment.status', 'payload.status', 'data.payment_status']) || ''
    ).toLowerCase();
    if (['paid', 'approved', 'completed', 'confirmed', 'success'].includes(nested)) return true;
    return false;
}

function extractPaidFromRemote(remoteData) {
    const d = remoteData && typeof remoteData === 'object' ? remoteData : {};
    const status = String(
        pickFirst(d, ['status', 'payment_status', 'state', 'data.status']) || ''
    ).toLowerCase();
    if (['paid', 'approved', 'completed', 'confirmed', 'success'].includes(status)) return true;
    if (['pending', 'waiting', 'processing'].includes(status)) return false;
    return false;
}

function extractAmountFromRemote(remoteData) {
    const d = remoteData && typeof remoteData === 'object' ? remoteData : {};
    const raw = pickFirst(d, ['amount', 'value', 'transaction_amount', 'data.amount', 'paid_amount']);
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
}

function extractQrFromCreateResponse(data) {
    const d = data && typeof data === 'object' ? data : {};
    const qr = pickFirst(d, [
        'qr_code',
        'brcode',
        'brCode',
        'copy_paste',
        'pix_copy_paste',
        'pix_copia_e_cola',
        'pixCopiaECola',
        'codigo_pix',
        'emv',
        'qrcode',
        'qrCode',
        'data.qr_code',
        'data.pix.qrcode',
        'data.pix.qr_code',
        'data.brcode',
        'pix.qr_code',
        'pix.qrcode',
        'payment.pix.qrcode',
        'transaction_data.qr_code',
        'result.qr_code',
        'result.pix_copia_e_cola'
    ]);
    const b64 = pickFirst(d, [
        'qr_code_base64',
        'qr_code_b64',
        'data.qr_code_base64',
        'data.qrCodeBase64',
        'transaction_data.qr_code_base64',
        'pix.qr_code_base64'
    ]);
    return {
        qr_code: qr ? String(qr) : null,
        qr_code_b64: b64 ? String(b64) : null
    };
}

function extractChargeIdFromCreateResponse(data) {
    const d = data && typeof data === 'object' ? data : {};
    const id = pickFirst(d, ['id', 'charge_id', 'uuid', 'transaction_id', 'data.id']);
    return id ? String(id) : null;
}

function extractExternalRef(remoteData) {
    const d = remoteData && typeof remoteData === 'object' ? remoteData : {};
    const v = pickFirst(d, ['external_id', 'external_ref', 'metadata.external_id', 'data.external_id']);
    return v ? String(v).trim() : '';
}

module.exports = {
    createPixCharge,
    getPixCharge,
    extractChargeIdFromWebhookBody,
    extractPaidFromWebhookBody,
    extractPaidFromRemote,
    extractAmountFromRemote,
    extractQrFromCreateResponse,
    extractChargeIdFromCreateResponse,
    extractExternalRef,
    pickFirst
};
