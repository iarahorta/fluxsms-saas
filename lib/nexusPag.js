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

/** Log no Railway: corpo da Nexus (nunca logar API key). */
function formatNexusLogPayload(data) {
    if (data == null) return null;
    const s = typeof data === 'string' ? data : JSON.stringify(data);
    return s.length > 6000 ? `${s.slice(0, 6000)}…(truncado)` : s;
}

function logNexusResponse(context, status, data) {
    console.error(
        `[NEXUSPAG] ${context} HTTP ${status} body=`,
        formatNexusLogPayload(data)
    );
}

function logNexusErr(context, err) {
    if (err && err.response) {
        console.error(
            `[NEXUSPAG] ${context} axios status=${err.response.status} data=`,
            formatNexusLogPayload(err.response.data)
        );
        return;
    }
    console.error(`[NEXUSPAG] ${context}`, err && err.message ? err.message : err);
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
    const brl = Math.round(amount * 100) / 100;
    const cents = Math.round(brl * 100);
    const desc = description || `FluxSMS recarga R$ ${brl.toFixed(2)}`;
    const base = { external_id: externalId, webhook_url: webhookUrl, description: desc };

    /* Sempre enviar "amount" em reais: a 3.ª variação antiga só mandava amount_cents e a Nexus validava amount=0. */
    const payloads = [
        { ...base, amount: brl, value: brl, amount_cents: cents },
        { ...base, amount: brl, value: brl },
        { ...base, amount: brl, amount_cents: cents },
        { ...base, value: brl },
        { ...base, amount: brl }
    ];

    let lastErr = null;
    for (const body of payloads) {
        try {
            const res = await client.post('/api/pix/create', body, { validateStatus: () => true });
            const d = res && res.data;
            if (res.status >= 200 && res.status < 300) {
                if (d && (d.success === false || d.ok === false)) {
                    logNexusResponse('POST /api/pix/create (success flag false)', res.status, d);
                    lastErr = new Error(
                        `HTTP ${res.status}: ${typeof d === 'string' ? d : JSON.stringify(d)}`
                    );
                    continue;
                }
                return { ok: true, status: res.status, data: d, bodyUsed: body };
            }
            logNexusResponse('POST /api/pix/create', res.status, d);
            lastErr = new Error(
                `HTTP ${res.status}: ${typeof d === 'string' ? d : JSON.stringify(d)}`
            );
        } catch (e) {
            logNexusErr('POST /api/pix/create (rede/axios)', e);
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
    if (res.status < 200 || res.status >= 300) {
        logNexusResponse(`GET /api/pix/${id.slice(0, 8)}…`, res.status, res.data);
    }
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

function nexusDataLayers(d) {
    if (d == null) return [];
    if (typeof d === 'string') {
        const t = d.trim();
        if (t.startsWith('{') || t.startsWith('[')) {
            try {
                const p = JSON.parse(t);
                return nexusDataLayers(p);
            } catch {
                return [d];
            }
        }
        return [d];
    }
    if (typeof d !== 'object') return [d];
    const layers = [d];
    ['data', 'result', 'payload', 'response', 'transaction', 'payment', 'pix', 'order'].forEach((k) => {
        if (d[k] && typeof d[k] === 'object' && !Array.isArray(d[k])) layers.push(d[k]);
    });
    return layers;
}

function extractQrFromCreateResponse(data) {
    const list = nexusDataLayers(data);
    const pathsQr = [
        'qr_code',
        'qrcode',
        'qrCode',
        'brcode',
        'brCode',
        'emv',
        'copy_paste',
        'copyPaste',
        'pix_copy_paste',
        'pix_copia_e_cola',
        'pixCopiaECola',
        'codigo_pix',
        'codigoCopiaECola',
        'code',
        'emvString',
        'string',
        'data.qr_code',
        'data.brcode',
        'result.qr_code',
        'result.pix_copia_e_cola',
        'pix.copia_cola',
        'pix.copiaEcola',
        'payload.qr_code',
        'payment.copy_paste',
        'payment.emv',
        'transaction_data.qr_code',
        'transaction_data.emv',
        'payment.pix.qr_code',
        'payment.qr_code',
        'pix.qr_code',
        'pix.qrcode',
        'payment.pix.qrcode'
    ];
    const pathsB64 = [
        'qr_code_base64',
        'qr_code_b64',
        'qrCodeBase64',
        'qrcode_base64',
        'data.qr_code_base64',
        'data.qrCodeBase64',
        'pix.qr_code_base64',
        'payment.qr_code_base64',
        'transaction_data.qr_code_base64',
        'image_base64'
    ];
    for (const layer of list) {
        const qr = pickFirst(layer, pathsQr);
        const b64 = pickFirst(layer, pathsB64);
        if (qr || b64) {
            return {
                qr_code: qr ? String(qr).trim() : null,
                qr_code_b64: b64 ? String(b64) : null
            };
        }
    }
    return { qr_code: null, qr_code_b64: null };
}

function extractChargeIdFromCreateResponse(data) {
    const idPaths = [
        'id',
        'charge_id',
        'uuid',
        'transaction_id',
        'txid',
        'data.id',
        'data.txid',
        'data.charge_id',
        'data.transaction_id',
        'result.id',
        'payload.id',
        'order.id',
        'payment.id',
        'transaction.id',
        'payment.charge_id',
        'pix.txid',
        'pix.id'
    ];
    for (const layer of nexusDataLayers(data)) {
        const id = pickFirst(layer, idPaths);
        if (id) return String(id);
    }
    return null;
}

/**
 * Se o POST /api/pix/create não traz o EMV/QR, tenta GET /api/pix/:id (id do create ou external_ref).
 */
async function resolvePixQrFromCreate(createdData, { externalRef } = {}) {
    let qr = extractQrFromCreateResponse(createdData);
    if (qr.qr_code || qr.qr_code_b64) {
        return { qr, getAttempts: [] };
    }
    const tryIds = [];
    const a = extractChargeIdFromCreateResponse(createdData);
    if (a) tryIds.push(a);
    const b = String(externalRef || '').trim();
    if (b && !tryIds.includes(b)) tryIds.push(b);
    const getAttempts = [];
    for (const tryId of tryIds) {
        try {
            const remote = await getPixCharge(tryId);
            getAttempts.push({ id: tryId, status: remote.status, hasData: !!remote.data });
            if (remote.status < 200 || remote.status >= 300) continue;
            qr = extractQrFromCreateResponse(remote.data);
            if (qr.qr_code || qr.qr_code_b64) {
                return { qr, getAttempts, remoteData: remote.data };
            }
        } catch (e) {
            logNexusErr(`resolvePixQrFromCreate GET id=${String(tryId).slice(0, 12)}…`, e);
            getAttempts.push({ id: tryId, error: e.message || String(e) });
        }
    }
    return { qr, getAttempts, remoteData: null };
}

function extractExternalRef(remoteData) {
    const d = remoteData && typeof remoteData === 'object' ? remoteData : {};
    const v = pickFirst(d, ['external_id', 'external_ref', 'metadata.external_id', 'data.external_id']);
    return v ? String(v).trim() : '';
}

module.exports = {
    createPixCharge,
    getPixCharge,
    resolvePixQrFromCreate,
    extractChargeIdFromWebhookBody,
    extractPaidFromWebhookBody,
    extractPaidFromRemote,
    extractAmountFromRemote,
    extractQrFromCreateResponse,
    extractChargeIdFromCreateResponse,
    extractExternalRef,
    pickFirst
};
