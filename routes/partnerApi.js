const express = require('express');
const { buildPartnerAuth } = require('../middleware/partnerAuth');

const router = express.Router();

router.get('/docs', (_req, res) => {
  res.json({
    ok: true,
    module: 'partner-api',
    version: 'v1',
    auth: 'x-api-key or Authorization: Bearer <API_KEY>',
    endpoints: [
      { method: 'GET', path: '/partner-api/docs', auth: false, description: 'Documentação base da API Partner' },
      { method: 'GET', path: '/partner-api/health', auth: true, description: 'Health check autenticado + allow list IP' },
      { method: 'GET', path: '/partner-api/me', auth: true, description: 'Dados do parceiro autenticado' },
      { method: 'POST', path: '/partner-api/chips', auth: true, description: 'Registrar chip no polo vinculado ao parceiro (bloqueio Em quarentena WhatsApp 30d)' },
      { method: 'GET', path: '/partner-api/worker/activations?polo_chave=', auth: true, description: 'Fila SMS waiting para chips deste polo (worker Electron)' },
      { method: 'POST', path: '/partner-api/worker/heartbeat', auth: true, description: 'Mantém polo ONLINE (ultima_comunicacao)' }
    ]
  });
});

router.use((req, res, next) => {
  const supabase = req.app.get('supabase');
  return buildPartnerAuth({ supabase })(req, res, next);
});

router.get('/health', (req, res) => {
  return res.json({
    ok: true,
    module: 'partner-api',
    partner_code: req.partner.partner_code,
    ip: req.partner.ip,
    ts: new Date().toISOString()
  });
});

/**
 * POST /partner-api/chips
 * Registra chip no polo cuja chave_acesso pertence ao parceiro (polos.partner_profile_id).
 */
router.post('/chips', async (req, res) => {
    const supabase = req.app.get('supabase');
    const { polo_chave, porta, numero, operadora } = req.body || {};

    if (!polo_chave || !porta) {
        return res.status(400).json({ ok: false, error: 'polo_chave_e_porta_obrigatorios' });
    }

    try {
        const { data: polo, error: polErr } = await supabase
            .from('polos')
            .select('id, partner_profile_id')
            .eq('chave_acesso', String(polo_chave))
            .maybeSingle();

        if (polErr || !polo) {
            return res.status(404).json({ ok: false, error: 'polo_nao_encontrado' });
        }
        if (polo.partner_profile_id !== req.partner.id) {
            return res.status(403).json({ ok: false, error: 'polo_nao_vinculado_a_este_parceiro' });
        }

        const row = {
            polo_id: polo.id,
            porta: String(porta),
            numero: numero != null ? String(numero) : null,
            operadora: operadora != null ? String(operadora) : null,
            status: 'idle',
            disponivel_em: null
        };

        const { data: chip, error: insErr } = await supabase.from('chips').insert(row).select('id, porta, numero, status, disponivel_em').maybeSingle();

        if (insErr) {
            const msg = insErr.message || '';
            if (msg.includes('Em Quarentena')) {
                return res.status(423).json({ ok: false, error: 'em_quarentena', detail: msg });
            }
            return res.status(400).json({ ok: false, error: 'insert_failed', detail: msg });
        }

        return res.status(201).json({ ok: true, chip });
    } catch (err) {
        return res.status(500).json({ ok: false, error: 'partner_chip_failed', detail: err.message });
    }
});

/**
 * GET /partner-api/worker/activations?polo_chave=...
 * Ativações em waiting cujo chip pertence ao polo (e polo ao parceiro).
 */
router.get('/worker/activations', async (req, res) => {
    const supabase = req.app.get('supabase');
    const polo_chave = req.query.polo_chave;
    if (!polo_chave) {
        return res.status(400).json({ ok: false, error: 'polo_chave_obrigatoria' });
    }
    try {
        const { data: polo, error: polErr } = await supabase
            .from('polos')
            .select('id, partner_profile_id')
            .eq('chave_acesso', String(polo_chave))
            .maybeSingle();

        if (polErr || !polo) {
            return res.status(404).json({ ok: false, error: 'polo_nao_encontrado' });
        }
        if (polo.partner_profile_id !== req.partner.id) {
            return res.status(403).json({ ok: false, error: 'polo_nao_vinculado_a_este_parceiro' });
        }

        const { data: chips, error: chipErr } = await supabase
            .from('chips')
            .select('id, porta, numero')
            .eq('polo_id', polo.id);
        if (chipErr) {
            return res.status(500).json({ ok: false, error: 'chips_list_failed', detail: chipErr.message });
        }

        const chipIds = (chips || []).map((c) => c.id).filter(Boolean);
        if (chipIds.length === 0) {
            return res.json({ ok: true, activations: [], chips: [] });
        }

        const { data: activations, error: actErr } = await supabase
            .from('activations')
            .select('id, chip_id, service, service_name, phone_number, status, price, created_at')
            .eq('status', 'waiting')
            .in('chip_id', chipIds)
            .order('created_at', { ascending: true });

        if (actErr) {
            return res.status(500).json({ ok: false, error: 'activations_failed', detail: actErr.message });
        }

        const chipById = Object.fromEntries((chips || []).map((c) => [c.id, c]));
        const enriched = (activations || []).map((a) => ({
            ...a,
            chip_porta: chipById[a.chip_id]?.porta || null,
            chip_numero: chipById[a.chip_id]?.numero || null
        }));

        return res.json({ ok: true, activations: enriched, chips: chips || [] });
    } catch (err) {
        return res.status(500).json({ ok: false, error: 'worker_activations_failed', detail: err.message });
    }
});

/**
 * POST /partner-api/worker/heartbeat { polo_chave }
 * Atualiza ultima_comunicacao para o painel considerar o polo ONLINE.
 */
router.post('/worker/heartbeat', async (req, res) => {
    const supabase = req.app.get('supabase');
    const { polo_chave } = req.body || {};
    if (!polo_chave) {
        return res.status(400).json({ ok: false, error: 'polo_chave_obrigatoria' });
    }
    try {
        const { data: polo, error: polErr } = await supabase
            .from('polos')
            .select('id, partner_profile_id')
            .eq('chave_acesso', String(polo_chave))
            .maybeSingle();

        if (polErr || !polo) {
            return res.status(404).json({ ok: false, error: 'polo_nao_encontrado' });
        }
        if (polo.partner_profile_id !== req.partner.id) {
            return res.status(403).json({ ok: false, error: 'polo_nao_vinculado_a_este_parceiro' });
        }

        const now = new Date().toISOString();
        const { error: upErr } = await supabase
            .from('polos')
            .update({ ultima_comunicacao: now, status: 'ONLINE' })
            .eq('id', polo.id);

        if (upErr) {
            return res.status(500).json({ ok: false, error: 'heartbeat_failed', detail: upErr.message });
        }

        return res.json({ ok: true, ts: now });
    } catch (err) {
        return res.status(500).json({ ok: false, error: 'worker_heartbeat_failed', detail: err.message });
    }
});

router.get('/me', async (req, res) => {
  try {
    const supabase = req.app.get('supabase');

    const { data: partner, error: partnerError } = await supabase
      .from('partner_profiles')
      .select('id, partner_code, status, margin_percent, created_at')
      .eq('id', req.partner.id)
      .maybeSingle();
    if (partnerError || !partner) return res.status(404).json({ ok: false, error: 'partner_not_found' });

    const { data: costs } = await supabase
      .from('partner_service_costs')
      .select('service, cost_price')
      .eq('partner_id', req.partner.id)
      .order('service');

    return res.json({
      ok: true,
      partner,
      costs: costs || []
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'partner_me_failed', detail: err.message });
  }
});

module.exports = router;
