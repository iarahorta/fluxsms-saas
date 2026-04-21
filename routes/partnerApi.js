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
      { method: 'POST', path: '/partner-api/chips', auth: true, description: 'Registrar chip no polo vinculado ao parceiro (bloqueio Em Quarentena WhatsApp 30d)' }
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
