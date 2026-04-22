const express = require('express');
const router  = express.Router();

/**
 * POST /sms/deliver
 * Recebe o código SMS do modem físico (Export_GSM_Codder).
 * PROTEGIDA: Requer API_KEY_SECRET no header Authorization.
 *
 * Body: { activation_id, sms_code, chip_porta }
 */
router.post('/deliver', async (req, res) => {
    const supabase = req.app.get('supabase');

    // ─── Autenticação: somente o hardware (seu PC) pode chamar ──
    const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');

    if (!apiKey || apiKey !== process.env.HARDWARE_API_KEY) {
        return res.status(401).json({ error: 'unauthorized' });
    }

    const { activation_id, sms_code, chip_porta } = req.body;

    if (!activation_id || !sms_code) {
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
            return res.status(500).json({ ok: false });
        }

        if (!actRow) {
            console.warn('[SMS DELIVER] Ativação não estava em waiting:', activation_id);
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
        return res.status(200).json({ ok: true });

    } catch (err) {
        console.error('[SMS DELIVER] Erro:', err.message);
        return res.status(500).json({ ok: false });
    }
});

/**
 * POST /sms/mock
 * SIMULAÇÃO: Para testes sem modem físico.
 * Também protegida pela mesma API_KEY.
 */
router.post('/mock', async (req, res) => {
    const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');

    if (!apiKey || apiKey !== process.env.HARDWARE_API_KEY) {
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

module.exports = router;
