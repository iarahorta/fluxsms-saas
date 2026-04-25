const express = require('express');
const router = express.Router();

const THREE_MIN_MS = 3 * 60 * 1000;

/** Estoque estrito do cliente: ONLINE + ping recente (3 min). */
function chipOnline3m(row) {
    const p = row.polos;
    const u = p && (Array.isArray(p) ? p[0] : p);
    const poloStatus = String((u && u.status) || '').toLowerCase();
    const status = String(row.status || '').toLowerCase();
    if (status !== 'online') return false;
    if (poloStatus && poloStatus !== 'online') return false;
    const lp = row.last_ping ? new Date(row.last_ping).getTime() : 0;
    const tLp = lp ? new Date(lp).getTime() : 0;
    return !!(tLp && Date.now() - tLp <= THREE_MIN_MS);
}

function chipServiceOffTrue(chip, key) {
    const o = chip.chip_service_off;
    if (!o || typeof o !== 'object') return false;
    return String(o[key] || o[(key || '').toLowerCase()]).toLowerCase() === 'true';
}

const DEFAULT_SERVICE_IDS = ['whatsapp', 'telegram', 'google', 'instagram'];

/**
 * GET /api/public/estoque
 * Estoque estrito para painel cliente: somente chips ONLINE com ping <= 3 min.
 */
router.get('/estoque', async (req, res) => {
    res.set('Cache-Control', 'public, max-age=5, s-maxage=5');
    try {
        const supabase = req.app.get('supabase');
        if (!supabase) return res.status(500).json({ ok: false, error: 'supabase_ausente' });

        let serviceIds = DEFAULT_SERVICE_IDS;
        const { data: cfgRows, error: cfgErr } = await supabase
            .from('services_config')
            .select('id');
        if (!cfgErr && Array.isArray(cfgRows) && cfgRows.length) {
            const u = [
                ...new Set(
                    cfgRows
                        .map((r) => (r && r.id != null ? String(r.id).trim() : ''))
                        .filter(Boolean)
                )
            ];
            if (u.length) serviceIds = u;
        }

        const { data: chips, error: e1 } = await supabase
            .from('chips')
            .select('id, status, numero, last_ping, disponivel_em, chip_service_off, polos(ultima_comunicacao, status)');

        if (e1) {
            return res.status(500).json({ ok: false, error: e1.message });
        }

        const { data: recActs, error: e2 } = await supabase
            .from('activations')
            .select('chip_id, service')
            .eq('status', 'received');

        if (e2) {
            return res.status(500).json({ ok: false, error: e2.message });
        }

        const receivedSet = new Set(
            (recActs || []).map((a) => String(a.chip_id) + '|' + String(a.service))
        );

        const list = (chips || []).filter(
            (c) => c && c.numero && String(c.numero).toUpperCase().indexOf('CCID') !== 0
        );

        let chipsVivos = 0;
        let chipsComAlgumEstoque = 0;
        const stocks = {};
        for (const s of serviceIds) stocks[s] = 0;

        for (const c of list) {
            const st = String(c.status || '').toLowerCase();
            if (chipOnline3m(c)) {
                chipsVivos += 1;
            }
            if (!chipOnline3m(c)) continue;

            let anyService = 0;
            for (const sid of serviceIds) {
                if (chipServiceOffTrue(c, sid)) continue;

                if (sid === 'whatsapp') {
                    const de = c.disponivel_em;
                    if (de && new Date(de) > new Date()) continue;
                }

                if (receivedSet.has(String(c.id) + '|' + sid)) continue;

                stocks[sid] += 1;
                anyService = 1;
            }
            chipsComAlgumEstoque += anyService;
        }

        return res.json({
            ok: true,
            chips_vivos: chipsVivos,
            /** Chips com estoque em ao menos um serviço. */
            chips_vendaveis: chipsComAlgumEstoque,
            stocks,
            at: new Date().toISOString()
        });
    } catch (err) {
        console.error('[api/public/estoque]', err);
        return res.status(500).json({ ok: false, error: String(err && err.message) });
    }
});

module.exports = router;
