const express = require('express');
const { buildPartnerAuth } = require('../middleware/partnerAuth');

const router = express.Router();

async function listPolosFromPartner(supabase, partnerId) {
  const { data, error } = await supabase
    .from('polos')
    .select('id, partner_profile_id, nome, status, ultima_comunicacao')
    .eq('partner_profile_id', partnerId);
  if (error) {
    return { ok: false, status: 500, body: { ok: false, error: 'polos_list_failed', detail: error.message } };
  }
  return { ok: true, polos: data || [] };
}

function pickPreferredPolo(polos) {
  const list = Array.isArray(polos) ? [...polos] : [];
  if (!list.length) return null;
  list.sort((a, b) => {
    const aOnline = String(a.status || '').toUpperCase() === 'ONLINE' ? 1 : 0;
    const bOnline = String(b.status || '').toUpperCase() === 'ONLINE' ? 1 : 0;
    if (aOnline !== bOnline) return bOnline - aOnline;
    const at = new Date(a.ultima_comunicacao || 0).getTime();
    const bt = new Date(b.ultima_comunicacao || 0).getTime();
    return bt - at;
  });
  return list[0];
}

async function ensurePartnerPolo(supabase, partnerId) {
  const polosScope = await listPolosFromPartner(supabase, partnerId);
  if (!polosScope.ok) return { ok: false, status: polosScope.status, body: polosScope.body };
  let polo = pickPreferredPolo(polosScope.polos);
  if (polo) return { ok: true, polo, polos: polosScope.polos };

  const { data: partnerProfile, error: pErr } = await supabase
    .from('partner_profiles')
    .select('partner_code')
    .eq('id', partnerId)
    .maybeSingle();
  if (pErr) return { ok: false, status: 500, body: { ok: false, error: 'partner_profile_failed', detail: pErr.message } };

  const baseKey = String(partnerProfile?.partner_code || `partner-${String(partnerId).slice(0, 8)}`).trim() || `partner-${String(partnerId).slice(0, 8)}`;
  const attempts = [baseKey, `${baseKey}-${String(partnerId).slice(0, 8)}`, `${baseKey}-${Date.now().toString().slice(-6)}`];
  let lastErr = null;
  for (const key of attempts) {
    const created = await supabase
      .from('polos')
      .insert({
        partner_profile_id: partnerId,
        nome: 'Estacao principal',
        status: 'ONLINE',
        chave_acesso: key
      })
      .select('id, partner_profile_id, chave_acesso, nome, status, ultima_comunicacao')
      .maybeSingle();
    if (!created.error && created.data) {
      return { ok: true, polo: created.data, polos: [created.data] };
    }
    lastErr = created.error;
    const msg = String(created.error?.message || '').toLowerCase();
    if (!msg.includes('duplicate key value') || !msg.includes('polos_chave_acesso_key')) break;
  }
  return {
    ok: false,
    status: 500,
    body: { ok: false, error: 'polo_autocreate_failed', detail: lastErr?.message || 'erro' }
  };
}

/**
 * Upsert chip no polo do parceiro autenticado (sem polo_chave no body — resolve só por partner_id).
 * Aceita aliases: port/number/operator.
 */
async function upsertPartnerWorkerChip(supabase, partnerId, bodyIn) {
  const body = bodyIn || {};
  const portaRaw = body.porta != null ? body.porta : body.port;
  const numero = body.numero != null ? body.numero : body.number;
  const operadora = body.operadora != null ? body.operadora : body.operator;

  if (!portaRaw || String(portaRaw).trim() === '') {
    return { status: 400, json: { ok: false, error: 'porta_obrigatoria' } };
  }

  try {
    const poloScope = await ensurePartnerPolo(supabase, partnerId);
    if (!poloScope.ok) return { status: poloScope.status, json: poloScope.body };
    const polo = poloScope.polo;
    const polos = poloScope.polos || (polo ? [polo] : []);
    if (!polo) {
      return { status: 404, json: { ok: false, error: 'polo_nao_encontrado' } };
    }

    const portaNorm = String(portaRaw).trim();
    const { data: existing } = await supabase
      .from('chips')
      .select('id, polo_id, porta')
      .in('polo_id', polos.map((p) => p.id))
      .ilike('porta', portaNorm)
      .limit(1)
      .maybeSingle();

    const row = {
      polo_id: existing?.polo_id || polo.id,
      porta: portaNorm,
      numero: numero != null ? String(numero) : null,
      operadora: operadora != null ? String(operadora) : null,
      status: 'idle',
      disponivel_em: null,
      last_ping: new Date().toISOString()
    };
    let chip = null;
    let insErr = null;
    if (existing?.id) {
      const upd = await supabase
        .from('chips')
        .update(row)
        .eq('id', existing.id)
        .select('id, porta, numero, status, disponivel_em')
        .maybeSingle();
      chip = upd.data;
      insErr = upd.error;
    } else {
      const ins = await supabase
        .from('chips')
        .insert(row)
        .select('id, porta, numero, status, disponivel_em')
        .maybeSingle();
      chip = ins.data;
      insErr = ins.error;
    }

    if (insErr) {
      const msg = insErr.message || '';
      if (msg.includes('Em Quarentena')) {
        return { status: 423, json: { ok: false, error: 'em_quarentena', detail: msg } };
      }
      return { status: 400, json: { ok: false, error: 'insert_failed', detail: msg } };
    }

    return { status: 201, json: { ok: true, chip } };
  } catch (err) {
    return { status: 500, json: { ok: false, error: 'partner_chip_failed', detail: err.message } };
  }
}

async function getPartnerServiceRules(supabase, partnerId) {
  let { data, error } = await supabase
    .from('partner_service_costs')
    .select('service, enabled')
    .eq('partner_id', partnerId);
  if (error && String(error.message || '').toLowerCase().includes('enabled')) {
    const legacy = await supabase
      .from('partner_service_costs')
      .select('service')
      .eq('partner_id', partnerId);
    data = legacy.data || [];
    error = legacy.error;
  }
  if (error) return { ok: false, error };
  const rows = data || [];
  const hasEnabledFlag = rows.some((r) => Object.prototype.hasOwnProperty.call(r, 'enabled'));
  const disabled = new Set(
    rows
      .filter((r) => hasEnabledFlag && r.enabled === false)
      .map((r) => String(r.service || '').trim().toLowerCase())
      .filter(Boolean)
  );
  return { ok: true, disabledServices: disabled };
}

router.get('/docs', (_req, res) => {
  res.json({
    ok: true,
    module: 'partner-api',
    version: 'v1',
    auth: 'x-api-key or Authorization: Bearer <API_KEY>; X-Flux-Hwid opcional (primeira vinculação); obrigatório se a chave já tiver bound_hwid',
    endpoints: [
      { method: 'GET', path: '/partner-api/docs', auth: false, description: 'Documentação base da API Partner' },
      { method: 'GET', path: '/partner-api/health', auth: true, description: 'Health check autenticado + allow list IP' },
      { method: 'GET', path: '/partner-api/me', auth: true, description: 'Dados do parceiro autenticado' },
      { method: 'POST', path: '/partner-api/chips', auth: true, description: 'Registrar chip no polo vinculado ao parceiro (bloqueio Em quarentena WhatsApp 30d)' },
      { method: 'POST', path: '/partner-api/worker/sync', auth: true, description: 'Sync imediato porta/número (desktop); mesmo upsert que /chips' },
      { method: 'GET', path: '/partner-api/worker/activations', auth: true, description: 'Fila SMS waiting para chips vinculados ao partner da API key' },
      { method: 'GET', path: '/partner-api/worker/chips', auth: true, description: 'Lista chips vinculados ao partner da API key (porta/número)' },
      { method: 'GET', path: '/partner-api/worker/chip-activations?porta=', auth: true, description: 'Histórico de ativações do chip (porta COM) do partner autenticado' },
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
 * GET /partner-api/worker/bootstrap
 * Resolve automaticamente a estação para uso no core local (POLO_KEY),
 * sem exigir que o parceiro informe chave manualmente no app.
 */
router.get('/worker/bootstrap', async (req, res) => {
  const supabase = req.app.get('supabase');
  try {
    const poloScope = await ensurePartnerPolo(supabase, req.partner.id);
    if (!poloScope.ok) return res.status(poloScope.status).json(poloScope.body);
    const polo = poloScope.polo;
    return res.json({
      ok: true,
      partner_id: req.partner.id,
      polo: {
        id: polo.id,
        chave_acesso: polo.chave_acesso || null,
        nome: polo.nome || null,
        status: polo.status || null
      }
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'worker_bootstrap_failed', detail: err.message });
  }
});

/**
 * POST /partner-api/chips
 * Registra chip no polo cuja chave_acesso pertence ao parceiro (polos.partner_profile_id).
 */
router.post('/chips', async (req, res) => {
  const supabase = req.app.get('supabase');
  const r = await upsertPartnerWorkerChip(supabase, req.partner.id, req.body);
  return res.status(r.status).json(r.json);
});

/**
 * POST /partner-api/worker/sync
 * Canal usado pelo desktop após ler JSON do core Python (IPC).
 */
router.post('/worker/sync', async (req, res) => {
  const supabase = req.app.get('supabase');
  const r = await upsertPartnerWorkerChip(supabase, req.partner.id, req.body);
  return res.status(r.status).json(r.json);
});

/**
 * GET /partner-api/worker/activations?polo_chave=...
 * Ativações em waiting cujo chip pertence ao polo (e polo ao parceiro).
 */
router.get('/worker/activations', async (req, res) => {
    const supabase = req.app.get('supabase');
    try {
        const polosScope = await listPolosFromPartner(supabase, req.partner.id);
        if (!polosScope.ok) return res.status(polosScope.status).json(polosScope.body);
        const poloIds = polosScope.polos.map((p) => p.id);
        if (!poloIds.length) return res.json({ ok: true, activations: [], chips: [] });

        const { data: chips, error: chipErr } = await supabase
            .from('chips')
            .select('id, porta, numero')
            .in('polo_id', poloIds);
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

        const svcRules = await getPartnerServiceRules(supabase, req.partner.id);
        const disabledServices = svcRules.ok ? svcRules.disabledServices : new Set();
        const chipById = Object.fromEntries((chips || []).map((c) => [c.id, c]));
        const enriched = (activations || [])
          .filter((a) => !disabledServices.has(String(a.service || '').trim().toLowerCase()))
          .map((a) => ({
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
 * GET /partner-api/worker/chips?polo_chave=...
 * Chips registados no servidor para esta estação (número vindo do cadastro / API).
 */
router.get('/worker/chips', async (req, res) => {
    const supabase = req.app.get('supabase');
    try {
        const polosScope = await listPolosFromPartner(supabase, req.partner.id);
        if (!polosScope.ok) return res.status(polosScope.status).json(polosScope.body);
        const poloIds = polosScope.polos.map((p) => p.id);
        if (!poloIds.length) return res.json({ ok: true, chips: [], polos: [] });

        const { data: chips, error: chipErr } = await supabase
            .from('chips')
            .select('id, porta, numero, status, operadora, disponivel_em')
            .in('polo_id', poloIds)
            .order('porta');
        if (chipErr) {
            return res.status(500).json({ ok: false, error: 'chips_list_failed', detail: chipErr.message });
        }
        return res.json({ ok: true, chips: chips || [], polos: polosScope.polos });
    } catch (err) {
        return res.status(500).json({ ok: false, error: 'worker_chips_failed', detail: err.message });
    }
});

/**
 * GET /partner-api/worker/chip-activations?polo_chave=...&porta=COM3
 * Histórico de ativações ligadas a um chip (porta) do polo.
 */
router.get('/worker/chip-activations', async (req, res) => {
    const supabase = req.app.get('supabase');
    const porta = req.query.porta;
    if (porta == null || String(porta).trim() === '') {
        return res.status(400).json({ ok: false, error: 'porta_obrigatoria' });
    }
    const portaNorm = String(porta).trim();
    const portaUpper = portaNorm.toUpperCase();
    try {
        const polosScope = await listPolosFromPartner(supabase, req.partner.id);
        if (!polosScope.ok) return res.status(polosScope.status).json(polosScope.body);
        const poloIds = polosScope.polos.map((p) => p.id);
        if (!poloIds.length) {
          return res.json({
            ok: true,
            activations: [],
            chip: null,
            polo: null
          });
        }

        const { data: chipRows, error: cErr } = await supabase
            .from('chips')
            .select('id, porta, numero, operadora, polo_id')
            .in('polo_id', poloIds);
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
                polo: null
            });
        }
        const polo = polosScope.polos.find((p) => p.id === chip.polo_id) || null;

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
            polo: polo ? { nome: polo.nome, status: polo.status, ultima: polo.ultima_comunicacao } : null
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
    try {
        const polosScope = await listPolosFromPartner(supabase, req.partner.id);
        if (!polosScope.ok) return res.status(polosScope.status).json(polosScope.body);
        const poloIds = polosScope.polos.map((p) => p.id);
        if (!poloIds.length) return res.json({ ok: true, ts: new Date().toISOString(), noop: true });

        const now = new Date().toISOString();
        const { error: upErr } = await supabase
            .from('polos')
            .update({ ultima_comunicacao: now, status: 'ONLINE' })
            .in('id', poloIds);

        if (upErr) {
            return res.status(500).json({ ok: false, error: 'heartbeat_failed', detail: upErr.message });
        }

        // Marca parceiro e chips vinculados como vivos (last_ping).
        await supabase
            .from('partner_profiles')
            .update({ last_ping: now })
            .eq('id', req.partner.id);
        await supabase
            .from('chips')
            .update({ last_ping: now })
            .in('polo_id', poloIds);

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
    try {
        const polosScope = await listPolosFromPartner(supabase, req.partner.id);
        if (!polosScope.ok) return res.status(polosScope.status).json(polosScope.body);
        const poloIds = polosScope.polos.map((p) => p.id);
        if (!poloIds.length) return res.json({ ok: true, ts: new Date().toISOString(), forced_offline: true, noop: true });

        const now = new Date().toISOString();
        await supabase
            .from('polos')
            .update({ status: 'OFFLINE', ultima_comunicacao: now })
            .in('id', poloIds);
        await supabase
            .from('chips')
            .update({ status: 'offline' })
            .in('polo_id', poloIds);

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
