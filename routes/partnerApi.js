const express = require('express');
const { buildPartnerAuth } = require('../middleware/partnerAuth');

const router = express.Router();

router.get('/docs', (_req, res) => {
  res.json({
    ok: true,
    module: 'partner-api',
    version: 'v1',
    auth: 'x-api-key or Authorization: Bearer <API_KEY> + header obrigatório X-Flux-Hwid (identificador estável do PC)',
    endpoints: [
      { method: 'GET', path: '/partner-api/docs', auth: false, description: 'Documentação base da API Partner' },
      { method: 'GET', path: '/partner-api/health', auth: true, description: 'Health check autenticado + allow list IP' },
      { method: 'GET', path: '/partner-api/me', auth: true, description: 'Dados do parceiro autenticado' },
      { method: 'POST', path: '/partner-api/chips', auth: true, description: 'Registrar chip no polo vinculado ao parceiro (bloqueio Em quarentena WhatsApp 30d)' },
      { method: 'GET', path: '/partner-api/worker/activations?polo_chave=', auth: true, description: 'Fila SMS waiting para chips deste polo (worker Electron)' },
      { method: 'GET', path: '/partner-api/worker/chip-activations?polo_chave=&porta=', auth: true, description: 'Histórico de ativações do chip (porta COM) para o painel do worker' },
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
 * GET /partner-api/worker/chip-activations?polo_chave=...&porta=COM3
 * Histórico de ativações ligadas a um chip (porta) do polo.
 */
router.get('/worker/chip-activations', async (req, res) => {
    const supabase = req.app.get('supabase');
    const polo_chave = req.query.polo_chave;
    const porta = req.query.porta;
    if (!polo_chave || porta == null || String(porta).trim() === '') {
        return res.status(400).json({ ok: false, error: 'polo_chave_e_porta_obrigatorias' });
    }
    const portaNorm = String(porta).trim();
    const portaUpper = portaNorm.toUpperCase();
    try {
        const { data: polo, error: polErr } = await supabase
            .from('polos')
            .select('id, partner_profile_id, nome, status, ultima_comunicacao')
            .eq('chave_acesso', String(polo_chave))
            .maybeSingle();

        if (polErr || !polo) {
            return res.status(404).json({ ok: false, error: 'polo_nao_encontrado' });
        }
        if (polo.partner_profile_id !== req.partner.id) {
            return res.status(403).json({ ok: false, error: 'polo_nao_vinculado_a_este_parceiro' });
        }

        const { data: chipRows, error: cErr } = await supabase
            .from('chips')
            .select('id, porta, numero, operadora')
            .eq('polo_id', polo.id);
        if (cErr) {
            return res.status(500).json({ ok: false, error: 'chip_lookup_failed', detail: cErr.message });
        }
        const chip = (chipRows || []).find(
            (c) => String(c.porta || '').toUpperCase() === portaUpper
        ) || null;
        if (!chip) {
            return res.json({
                ok: true,
                activations: [],
                chip: null,
                polo: { nome: polo.nome, status: polo.status, ultima: polo.ultima_comunicacao }
            });
        }

        const { data: activations, error: actErr } = await supabase
            .from('activations')
            .select('id, service, service_name, price, status, created_at')
            .eq('chip_id', chip.id)
            .order('created_at', { ascending: false })
            .limit(200);

        if (actErr) {
            return res.status(500).json({ ok: false, error: 'activations_failed', detail: actErr.message });
        }

        return res.json({
            ok: true,
            activations: activations || [],
            chip,
            polo: { nome: polo.nome, status: polo.status, ultima: polo.ultima_comunicacao }
        });
    } catch (err) {
        return res.status(500).json({ ok: false, error: 'chip_activations_failed', detail: err.message });
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

        // Marca parceiro e chips vinculados como vivos (last_ping).
        await supabase
            .from('partner_profiles')
            .update({ last_ping: now })
            .eq('id', polo.partner_profile_id);
        await supabase
            .from('chips')
            .update({ last_ping: now })
            .eq('polo_id', polo.id);

        return res.json({ ok: true, ts: now });
    } catch (err) {
        return res.status(500).json({ ok: false, error: 'worker_heartbeat_failed', detail: err.message });
    }
});

/**
 * POST /partner-api/worker/shutdown { polo_chave }
 * Graceful shutdown do app desktop: polo/chips OFFLINE imediatos.
 */
router.post('/worker/shutdown', async (req, res) => {
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
        await supabase
            .from('polos')
            .update({ status: 'OFFLINE', ultima_comunicacao: now })
            .eq('id', polo.id);
        await supabase
            .from('chips')
            .update({ status: 'offline' })
            .eq('polo_id', polo.id);

        return res.json({ ok: true, ts: now, forced_offline: true });
    } catch (err) {
        return res.status(500).json({ ok: false, error: 'worker_shutdown_failed', detail: err.message });
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
