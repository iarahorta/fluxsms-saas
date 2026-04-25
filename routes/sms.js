const express = require('express');
const router  = express.Router();
const { distributeActivationSaleWallets } = require('../lib/saleWalletDistribution');

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
        const { data: actRow, error: actError } = await supabase
            .from('activations')
            .update({ sms_code, status: 'received', updated_at: new Date().toISOString() })
            .eq('id', activation_id)
            .eq('status', 'waiting')
            .select('service, chip_id, price')
            .maybeSingle();

        if (actError) {
            console.error('[SMS DELIVER] Erro ao atualizar ativação:', actError.message);
            return res.status(500).json({ ok: false });
        }

        if (!actRow) {
            console.warn('[SMS DELIVER] Ativação não estava em waiting:', activation_id);
            return res.status(409).json({ ok: false, error: 'activation_not_waiting' });
        }

        // 2. Marca o serviço como "off" apenas para o canal vendido (multicanal),
        //    mantendo o chip disponível para outros serviços (estado físico idle).
        const srvKey = String(actRow.service || '').trim().toLowerCase();
        const chipUpdateBase = { status: 'idle', disponivel_em: null };

        if (actRow.chip_id) {
            const { data: curChip, error: curErr } = await supabase
                .from('chips')
                .select('chip_service_off')
                .eq('id', actRow.chip_id)
                .maybeSingle();
            if (curErr) console.error('[SMS DELIVER] Erro ao ler chip:', curErr.message);

            const prev = (curChip && curChip.chip_service_off && typeof curChip.chip_service_off === 'object')
                ? curChip.chip_service_off
                : {};
            const chip_service_off = { ...prev, [srvKey]: true };

            const { error: chipErr } = await supabase
                .from('chips')
                .update({ ...chipUpdateBase, chip_service_off })
                .eq('id', actRow.chip_id);
            if (chipErr) console.error('[SMS DELIVER] Erro ao atualizar chip:', chipErr.message);
        } else if (chip_porta) {
            const { data: curChip2, error: curErr2 } = await supabase
                .from('chips')
                .select('id, chip_service_off')
                .eq('porta', chip_porta)
                .maybeSingle();
            if (curErr2) console.error('[SMS DELIVER] Erro ao ler chip (porta):', curErr2.message);

            const prev2 = (curChip2 && curChip2.chip_service_off && typeof curChip2.chip_service_off === 'object')
                ? curChip2.chip_service_off
                : {};
            const chip_service_off2 = { ...prev2, [srvKey]: true };

            const { error: chipErr2 } = await supabase
                .from('chips')
                .update({ ...chipUpdateBase, chip_service_off: chip_service_off2 })
                .eq('porta', chip_porta);
            if (chipErr2) console.error('[SMS DELIVER] Erro chip (porta):', chipErr2.message);
        }

        // 3. Distribuição interna (wallets virtuais) — não bloqueia entrega do SMS
        try {
            const dist = await distributeActivationSaleWallets(supabase, activation_id);
            if (!dist.ok) {
                console.warn('[SMS DELIVER] Distribuição wallets:', dist.error || dist);
            }
        } catch (e) {
            console.warn('[SMS DELIVER] Distribuição wallets falhou:', e.message || e);
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
