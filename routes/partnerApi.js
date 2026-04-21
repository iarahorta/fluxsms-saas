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
      { method: 'GET', path: '/partner-api/me', auth: true, description: 'Dados do parceiro autenticado' }
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
