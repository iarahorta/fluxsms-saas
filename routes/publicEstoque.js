const express = require('express');
const router = express.Router();

const SIXTY_MIN_MS = 60 * 60 * 1000;

/**
 * Sinal de vida: last_ping ou polo.ultima nos últimos 60 min, ou totalmente sem dado = assume vivo (prioridade: números visíveis no painel).
 */
function chipSinalVida60m(row) {
    const p = row.polos;
    const u = p && (Array.isArray(p) ? p[0] : p);
    const ult = u && u.ultima_comunicacao;
    const lp = row.last_ping;
    const tUlt = ult ? new Date(ult).getTime() : 0;
    const tLp = lp ? new Date(lp).getTime() : 0;
    if (tUlt && Date.now() - tUlt <= SIXTY_MIN_MS) return true;
    if (tLp && Date.now() - tLp <= SIXTY_MIN_MS) return true;
    if (!tUlt && !tLp) return true;
    return false;
}

function chipServiceOffTrue(chip, key) {
    const o = chip.chip_service_off;
    if (!o || typeof o !== 'object') return false;
    return String(o[key] || o[(key || '').toLowerCase()]).toLowerCase() === 'true';
}

const DEFAULT_SERVICE_IDS = ['whatsapp', 'telegram', 'google', 'instagram'];

/**
 * GET /api/public/estoque
 * Plano B: contagens reais (service role), sem exigir polo status ONLINE, nem chip estritamente “idle”
 * se houver sinal de vida 60m e ainda estiver mapeado como “offline” pelo heartbeat.
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
            if (
                chipSinalVida60m(c) ||
                st === 'idle' ||
                st === 'quarentena' ||
                st === 'on' ||
                st === 'online' ||
                st === 'active' ||
                st === 'busy' ||
                st === 'offline'
            ) {
                chipsVivos += 1;
            }
            const poloU =
                c.polos && (c.polos.ultima_comunicacao || (Array.isArray(c.polos) && c.polos[0] && c.polos[0].ultima_comunicacao));
            const vivoOffline = st === 'offline' && (c.last_ping || poloU);

            let anyService = 0;
            for (const sid of serviceIds) {
                if (chipServiceOffTrue(c, sid)) continue;

                const okOn = st === 'on' || st === 'online' || st === 'active';
                if (sid === 'whatsapp') {
                    const de = c.disponivel_em;
                    if (de && new Date(de) > new Date()) continue;
                    if (!(st === 'idle' || okOn || (vivoOffline && (c.last_ping || 1)))) continue;
                } else {
                    const can = st === 'idle' || st === 'quarentena' || okOn || (vivoOffline && (c.last_ping || 1));
                    if (!can) continue;
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
