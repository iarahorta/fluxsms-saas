const express = require('express');
const router  = express.Router();
const crypto = require('crypto');

function sha256Hex(value) {
    return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function getSmsApiKey(req) {
    return String(req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '') || '').trim();
}

async function logSmsIngestionEvent(supabase, payload) {
    if (!supabase || !payload) return;
    try {
        await supabase.from('sms_ingestion_events').insert(payload);
    } catch (_e) {
        // Nunca bloquear entrega por falha de auditoria.
    }
}

async function isAuthorizedSmsSender(supabase, req) {
    const apiKey = getSmsApiKey(req);
    if (!apiKey) return false;
    if (apiKey === String(process.env.HARDWARE_API_KEY || '').trim()) return true;
    const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
    let { data, error } = await supabase
        .from('partner_api_keys')
        .select('id, is_active, expires_at')
        .eq('key_hash', keyHash)
        .maybeSingle();
    if (error && String(error.message || '').toLowerCase().includes('is_active')) {
        const legacy = await supabase
            .from('partner_api_keys')
            .select('id, expires_at')
            .eq('key_hash', keyHash)
            .maybeSingle();
        data = legacy.data;
        error = legacy.error;
    }
    if (error || !data) return false;
    if (Object.prototype.hasOwnProperty.call(data, 'is_active') && data.is_active === false) return false;
    if (data.expires_at && new Date(data.expires_at).getTime() <= Date.now()) return false;
    return true;
}

/**
 * POST /sms/deliver
 * Recebe o código SMS do modem físico (Export_GSM_Codder).
 * PROTEGIDA: Requer API_KEY_SECRET no header Authorization.
 *
 * Body: { activation_id, sms_code, chip_porta }
 */
router.post('/deliver', async (req, res) => {
    const supabase = req.app.get('supabase');
    const startedAt = new Date().toISOString();
    const apiKey = getSmsApiKey(req);
    const authorized = await isAuthorizedSmsSender(supabase, req);
    if (!authorized) {
        await logSmsIngestionEvent(supabase, {
            source: 'sms.deliver',
            outcome: 'unauthorized',
            reason: 'invalid_api_key',
            activation_id: req.body?.activation_id || null,
            chip_porta: req.body?.chip_porta || null,
            api_key_hash: apiKey ? sha256Hex(apiKey) : null,
            metadata: {
                started_at: startedAt,
                has_sms_code: !!req.body?.sms_code,
            },
        });
        return res.status(401).json({ error: 'unauthorized' });
    }

    const { activation_id, sms_code, chip_porta } = req.body;

    if (!activation_id || !sms_code) {
        await logSmsIngestionEvent(supabase, {
            source: 'sms.deliver',
            outcome: 'discarded',
            reason: 'invalid_payload',
            activation_id: activation_id || null,
            chip_porta: chip_porta || null,
            api_key_hash: apiKey ? sha256Hex(apiKey) : null,
            metadata: {
                started_at: startedAt,
                has_sms_code: !!sms_code,
            },
        });
        return res.status(400).json({ error: 'activation_id e sms_code sao obrigatorios' });
    }

    try {
        // 1. Atualiza a ativação e lê serviço/chip (quarentena WhatsApp = 30 dias)
        const waQuarantineUntil = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

        const { data: actRow, error: actError } = await supabase
            .from('activations')
            .update({ sms_code, status: 'received', updated_at: new Date().toISOString() })
            .eq('id', activation_id)
            .eq('status', 'waiting')
            .select('service, chip_id')
            .maybeSingle();

        if (actError) {
            console.error('[SMS DELIVER] Erro ao atualizar ativação:', actError.message);
            await logSmsIngestionEvent(supabase, {
                source: 'sms.deliver',
                outcome: 'error',
                reason: 'activation_update_failed',
                activation_id,
                chip_porta: chip_porta || null,
                api_key_hash: apiKey ? sha256Hex(apiKey) : null,
                metadata: {
                    started_at: startedAt,
                    db_error: actError.message,
                },
            });
            return res.status(500).json({ ok: false });
        }

        if (!actRow) {
            console.warn('[SMS DELIVER] Ativação não estava em waiting:', activation_id);
            await logSmsIngestionEvent(supabase, {
                source: 'sms.deliver',
                outcome: 'discarded',
                reason: 'activation_not_waiting',
                activation_id,
                chip_porta: chip_porta || null,
                api_key_hash: apiKey ? sha256Hex(apiKey) : null,
                metadata: {
                    started_at: startedAt,
                },
            });
            return res.status(409).json({ ok: false, error: 'activation_not_waiting' });
        }

        // 2. Libera o chip: WhatsApp → quarentena 30d; demais → idle
        const chipPatch =
            actRow.service === 'whatsapp'
                ? { status: 'quarentena', disponivel_em: waQuarantineUntil }
                : { status: 'idle', disponivel_em: null };

        if (actRow.chip_id) {
            const { error: chipErr } = await supabase.from('chips').update(chipPatch).eq('id', actRow.chip_id);
            if (chipErr) console.error('[SMS DELIVER] Erro ao atualizar chip:', chipErr.message);
        } else if (chip_porta) {
            const { error: chipErr2 } = await supabase.from('chips').update(chipPatch).eq('porta', chip_porta);
            if (chipErr2) console.error('[SMS DELIVER] Erro chip (porta):', chipErr2.message);
        }

        console.log(`[SMS DELIVER] SMS entregue. Ativação: ${activation_id} | Código: ${sms_code}`);
        await logSmsIngestionEvent(supabase, {
            source: 'sms.deliver',
            outcome: 'delivered',
            reason: 'ok',
            activation_id,
            chip_porta: chip_porta || null,
            api_key_hash: apiKey ? sha256Hex(apiKey) : null,
            metadata: {
                started_at: startedAt,
                service: actRow.service || null,
                sms_code_len: String(sms_code || '').length,
                sms_code_tail: String(sms_code || '').slice(-2),
            },
        });
        return res.status(200).json({ ok: true });

    } catch (err) {
        console.error('[SMS DELIVER] Erro:', err.message);
        await logSmsIngestionEvent(supabase, {
            source: 'sms.deliver',
            outcome: 'error',
            reason: 'unexpected_exception',
            activation_id: activation_id || null,
            chip_porta: chip_porta || null,
            api_key_hash: apiKey ? sha256Hex(apiKey) : null,
            metadata: {
                started_at: startedAt,
                error: err.message,
            },
        });
        return res.status(500).json({ ok: false });
    }
});

/**
 * POST /sms/mock
 * SIMULAÇÃO: Para testes sem modem físico.
 * Também protegida pela mesma API_KEY.
 */
router.post('/mock', async (req, res) => {
    const supabase = req.app.get('supabase');
    const authorized = await isAuthorizedSmsSender(supabase, req);
    if (!authorized) {
        return res.status(401).json({ error: 'unauthorized' });
    }

    const { activation_id } = req.body;
    if (!activation_id) return res.status(400).json({ error: 'activation_id obrigatorio' });

    // Gera código aleatório de 6 dígitos
    const fakeCode = String(Math.floor(100000 + Math.random() * 900000));

    // Reutiliza a rota real com o código simulado
    req.body.sms_code = fakeCode;
    req.body.chip_porta = null;

    console.log(`[MOCK SMS] Simulando código ${fakeCode} para ativação ${activation_id}`);
    return res.status(200).json({ ok: true, mock_code: fakeCode, msg: 'Usado apenas para testes' });
});

/**
 * POST /sms/shutdown
 * Força OFFLINE de todos os chips de uma estação (chave_acesso) no desligamento do app desktop.
 * Header: x-api-key (ou Authorization: Bearer)
 * Body opcional: { polo_key?: string }
 */
router.post('/shutdown', async (req, res) => {
    const supabase = req.app.get('supabase');
    const authorized = await isAuthorizedSmsSender(supabase, req);
    if (!authorized) {
        return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    const poloKey = String(req.body?.polo_key || req.headers['x-polo-key'] || '').trim();
    if (!poloKey) {
        return res.status(400).json({ ok: false, error: 'polo_key_obrigatoria' });
    }

    try {
        const { data: polo, error: poloErr } = await supabase
            .from('polos')
            .select('id')
            .eq('chave_acesso', poloKey)
            .maybeSingle();

        if (poloErr || !polo?.id) {
            return res.status(404).json({ ok: false, error: 'polo_nao_encontrado' });
        }

        await supabase
            .from('polos')
            .update({ status: 'OFFLINE', chips_ativos: 0, ultima_comunicacao: new Date().toISOString() })
            .eq('id', polo.id);

        await supabase
            .from('chips')
            .update({ status: 'offline' })
            .eq('polo_id', polo.id);

        return res.status(200).json({ ok: true, polo_id: polo.id, forced_offline: true });
    } catch (err) {
        return res.status(500).json({ ok: false, error: 'shutdown_failed', detail: err.message });
    }
});

module.exports = router;
