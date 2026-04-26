const express = require('express');
const crypto = require('crypto');
const { buildPartnerAuth } = require('../middleware/partnerAuth');
const { buildFinanceSummary, resolvePartnerCommissionPercent } = require('./partnerFinance');
const { encryptPartnerApiKeyPlain, decryptPartnerApiKeySecret } = require('../lib/partnerKeyVault');

const router = express.Router();

function createPartnerApiPlainKey() {
  return `flux_partner_${crypto.randomBytes(24).toString('hex')}`;
}

async function issuePartnerApiKeyForDesktop(supabase, partnerId) {
  const plain = createPartnerApiPlainKey();
  const keyHash = crypto.createHash('sha256').update(plain).digest('hex');
  const keyPrefix = plain.slice(0, 14);
  const vault = encryptPartnerApiKeyPlain(plain);
  const payload = {
    partner_id: partnerId,
    key_hash: keyHash,
    key_prefix: keyPrefix,
    label: 'Desktop Auto',
    is_active: true,
    bound_hwid: null
  };
  if (vault) {
    payload.secret_ciphertext = vault.ciphertext;
    payload.secret_iv = vault.iv;
    payload.secret_tag = vault.tag;
  }
  const { error } = await supabase.from('partner_api_keys').insert(payload);
  if (error) throw new Error(error.message || 'api_key_issue_failed');
  return plain;
}

async function listPolosFromPartner(supabase, partnerId) {
  const { data, error } = await supabase
    .from('polos')
    .select('id, partner_profile_id, nome, status, ultima_comunicacao, chave_acesso')
    .eq('partner_profile_id', partnerId);
  if (error) {
    return { ok: false, status: 500, body: { ok: false, error: 'polos_list_failed', detail: error.message } };
  }
  return { ok: true, polos: data || [] };
}

/** Leitura worker: chips sem chave (legado) continuam visíveis no mesmo polo do parceiro. */
function applyWorkerChipsReadScope(query, apiKeyId) {
  const kid = String(apiKeyId || '').trim();
  if (!kid) return query.or('registered_by_api_key_id.is.null');
  return query.or(`registered_by_api_key_id.eq.${kid},registered_by_api_key_id.is.null`);
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
  if (polo) {
    // Auto-cura: alguns polos legados ficaram sem chave_acesso.
    if (!String(polo.chave_acesso || '').trim()) {
      const fallbackKeyBase = `partner-${String(partnerId).slice(0, 8)}`;
      const attempts = [
        fallbackKeyBase,
        `${fallbackKeyBase}-${Date.now().toString().slice(-6)}`,
        `${fallbackKeyBase}-${Math.random().toString(36).slice(2, 8)}`
      ];
      let healed = null;
      for (const k of attempts) {
        const upd = await supabase
          .from('polos')
          .update({ chave_acesso: k })
          .eq('id', polo.id)
          .select('id, partner_profile_id, chave_acesso, nome, status, ultima_comunicacao')
          .maybeSingle();
        if (!upd.error && upd.data && String(upd.data.chave_acesso || '').trim()) {
          healed = upd.data;
          break;
        }
        const msg = String(upd.error?.message || '').toLowerCase();
        if (!(msg.includes('duplicate key value') && msg.includes('polos_chave_acesso_key'))) {
          break;
        }
      }
      if (healed) {
        polo = healed;
      }
    }
    return { ok: true, polo, polos: polosScope.polos };
  }

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

function normalizePhoneCandidate(value) {
  const raw = value == null ? '' : String(value).trim();
  if (!raw) return null;
  const lowered = raw.toLowerCase();
  // Estados visuais do desktop não podem substituir número real do chip.
  if (lowered === 'ocupada' || lowered === 'aguardando' || lowered === 'offline') return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 16) return null;
  return digits;
}

/**
 * Upsert chip no polo do parceiro autenticado (sem polo_chave no body — resolve só por partner_id).
 * Aceita aliases: port/number/operator.
 */
async function upsertPartnerWorkerChip(supabase, partnerId, bodyIn, apiKeyId) {
  const body = bodyIn || {};
  const portaRaw = body.porta != null ? body.porta : body.port;
  const numero = body.numero != null ? body.numero : body.number;
  const operadora = body.operadora != null ? body.operadora : body.operator;

  if (!portaRaw || String(portaRaw).trim() === '') {
    return { status: 400, json: { ok: false, error: 'porta_obrigatoria' } };
  }
  if (!apiKeyId) {
    return { status: 500, json: { ok: false, error: 'api_key_context_missing' } };
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
      .select('id, polo_id, porta, numero, registered_by_api_key_id')
      .in('polo_id', polos.map((p) => p.id))
      .ilike('porta', portaNorm)
      .limit(1)
      .maybeSingle();

    if (existing?.registered_by_api_key_id && existing.registered_by_api_key_id !== apiKeyId) {
      return {
        status: 409,
        json: {
          ok: false,
          error: 'chip_registado_outra_chave',
          detail: 'Esta porta já está registada noutra chave API do mesmo parceiro.'
        }
      };
    }

    const incomingPhone = normalizePhoneCandidate(numero);
    const existingPhone = normalizePhoneCandidate(existing?.numero);
    const normalizedNumero = incomingPhone || existingPhone || null;

    const row = {
      polo_id: existing?.polo_id || polo.id,
      porta: portaNorm,
      // Não apagar número já conhecido quando o worker enviar sync sem número.
      numero: normalizedNumero,
      operadora: operadora != null ? String(operadora) : null,
      // Worker ativo deve refletir ONLINE no painel/tabela.
      status: normalizedNumero ? 'online' : 'offline',
      disponivel_em: null,
      last_ping: new Date().toISOString(),
      registered_by_api_key_id: apiKeyId
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
      { method: 'GET', path: '/api', auth: false, description: 'Documentação HTML humana (navegador)' },
      { method: 'GET', path: '/partner-api/docs', auth: false, description: 'Documentação base da API Partner (JSON)' },
      { method: 'POST', path: '/partner-api/auth/login', auth: false, description: 'Login com e-mail/senha (web) para devolver chave de integração ativa ao desktop' },
      { method: 'GET', path: '/partner-api/health', auth: true, description: 'Health check autenticado + allow list IP' },
      { method: 'GET', path: '/partner-api/me', auth: true, description: 'Dados do parceiro autenticado' },
      { method: 'GET', path: '/partner-api/worker/bootstrap', auth: true, description: 'Resolve polo e chave_acesso (POLO_KEY) para o worker' },
      { method: 'GET', path: '/partner-api/worker/summary', auth: true, description: 'Resumo financeiro (saldo disponível, commission_percent)' },
      { method: 'POST', path: '/partner-api/chips', auth: true, description: 'Registrar chip no polo vinculado ao parceiro (bloqueio Em quarentena WhatsApp 30d)' },
      { method: 'POST', path: '/partner-api/worker/sync', auth: true, description: 'Sync imediato porta/número (desktop); mesmo upsert que /chips' },
      { method: 'GET', path: '/partner-api/worker/activations', auth: true, description: 'Fila SMS waiting para chips vinculados ao partner da API key' },
      { method: 'GET', path: '/partner-api/worker/chips', auth: true, description: 'Lista chips vinculados ao partner da API key (porta/número)' },
      { method: 'GET', path: '/partner-api/worker/chip-activations?porta=', auth: true, description: 'Histórico de ativações do chip (porta COM) do partner autenticado' },
      { method: 'POST', path: '/partner-api/worker/heartbeat', auth: true, description: 'Mantém polo ONLINE (ultima_comunicacao)' },
      { method: 'POST', path: '/partner-api/worker/shutdown', auth: true, description: 'Encerramento graceful: polo/chips OFFLINE' },
      { method: 'POST', path: '/partner-api/worker/sync-com-ports', auth: true, description: 'Lista de portas COM presentes no SO; marca OFFLINE chips desta chave que sumiram' }
    ]
  });
});

/**
 * POST /partner-api/auth/login
 * Permite o desktop usar o mesmo login do web sem exigir colagem manual da chave.
 * body: { email, password }
 */
router.post('/auth/login', async (req, res) => {
  const supabase = req.app.get('supabase');
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (!email || !password) {
    return res.status(400).json({ ok: false, error: 'email_password_required' });
  }
  try {
    const { data: loginData, error: loginErr } = await supabase.auth.signInWithPassword({ email, password });
    if (loginErr || !loginData?.user?.id) {
      return res.status(401).json({ ok: false, error: 'invalid_credentials' });
    }
    const userId = loginData.user.id;
    const { data: partner, error: partnerErr } = await supabase
      .from('partner_profiles')
      .select('id, partner_code, status')
      .eq('user_id', userId)
      .maybeSingle();
    if (partnerErr || !partner || String(partner.status || '').toLowerCase() !== 'active') {
      return res.status(403).json({ ok: false, error: 'partner_inactive_or_not_found' });
    }

    const { data: keys, error: keysErr } = await supabase
      .from('partner_api_keys')
      .select('id, is_active, expires_at, secret_ciphertext, secret_iv, secret_tag')
      .eq('partner_id', partner.id)
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(10);
    if (keysErr) {
      return res.status(500).json({ ok: false, error: 'keys_list_failed', detail: keysErr.message });
    }

    const nowMs = Date.now();
    let plain = null;
    for (const row of (keys || [])) {
      const expMs = row.expires_at ? new Date(row.expires_at).getTime() : null;
      if (expMs && Number.isFinite(expMs) && expMs <= nowMs) continue;
      const dec = decryptPartnerApiKeySecret(row);
      if (dec) {
        plain = dec;
        break;
      }
    }

    if (!plain) {
      plain = await issuePartnerApiKeyForDesktop(supabase, partner.id);
    }

    return res.json({
      ok: true,
      partner_id: partner.id,
      partner_code: partner.partner_code || null,
      api_key: plain
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'partner_login_failed', detail: err.message });
  }
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
 * GET /partner-api/worker/summary
 * Resumo financeiro do parceiro autenticado por API key (desktop).
 */
router.get('/worker/summary', async (req, res) => {
  const supabase = req.app.get('supabase');
  try {
    let partnerProfile = null;
    let pErr = null;
    ({ data: partnerProfile, error: pErr } = await supabase
      .from('partner_profiles')
      .select('id, created_at, saque_prioritario, margin_percent, custom_commission')
      .eq('id', req.partner.id)
      .maybeSingle());
    if (pErr && String(pErr.message || '').includes('custom_commission')) {
      const retry = await supabase
        .from('partner_profiles')
        .select('id, created_at, saque_prioritario, margin_percent')
        .eq('id', req.partner.id)
        .maybeSingle();
      partnerProfile = retry.data ? { ...retry.data, custom_commission: null } : null;
      pErr = retry.error;
    }
    if (pErr || !partnerProfile) {
      return res.status(404).json({ ok: false, error: 'partner_not_found' });
    }
    const finance = await buildFinanceSummary(supabase, partnerProfile);
    const totals = finance?.totals || {};
    const commissionPercent = resolvePartnerCommissionPercent(partnerProfile);
    return res.json({
      ok: true,
      commission_percent: commissionPercent,
      saldo_total: Number(totals.disponivel_para_solicitar || 0),
      finance_totals: totals
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'worker_summary_failed', detail: err.message });
  }
});

/**
 * POST /partner-api/chips
 * Registra chip no polo cuja chave_acesso pertence ao parceiro (polos.partner_profile_id).
 */
router.post('/chips', async (req, res) => {
  const supabase = req.app.get('supabase');
  const r = await upsertPartnerWorkerChip(supabase, req.partner.id, req.body, req.partner.api_key_id);
  return res.status(r.status).json(r.json);
});

/**
 * POST /partner-api/worker/sync
 * Canal usado pelo desktop após ler JSON do core Python (IPC).
 */
router.post('/worker/sync', async (req, res) => {
  const supabase = req.app.get('supabase');
  const r = await upsertPartnerWorkerChip(supabase, req.partner.id, req.body, req.partner.api_key_id);
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

        const { data: chips, error: chipErr } = await applyWorkerChipsReadScope(
            supabase.from('chips').select('id, porta, numero').in('polo_id', poloIds),
            req.partner.api_key_id
        );
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

        const { data: chips, error: chipErr } = await applyWorkerChipsReadScope(
            supabase
                .from('chips')
                .select('id, porta, numero, status, operadora, disponivel_em')
                .in('polo_id', poloIds),
            req.partner.api_key_id
        ).order('porta');
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

        const { data: chipRows, error: cErr } = await applyWorkerChipsReadScope(
            supabase.from('chips').select('id, porta, numero, operadora, polo_id').in('polo_id', poloIds),
            req.partner.api_key_id
        );
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

        // Marca parceiro e chips vinculados como vivos (last_ping) e ONLINE.
        await supabase
            .from('partner_profiles')
            .update({ last_ping: now })
            .eq('id', req.partner.id);
        await supabase
            .from('chips')
            .update({ status: 'online', last_ping: now })
            .in('polo_id', poloIds)
            .eq('registered_by_api_key_id', req.partner.api_key_id);

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
        // Só chips desta API Key: outro PC/chave do mesmo parceiro continua a poder manter o polo online.
        await supabase
            .from('chips')
            .update({ status: 'offline', last_ping: now })
            .in('polo_id', poloIds)
            .eq('registered_by_api_key_id', req.partner.api_key_id);

        return res.json({ ok: true, ts: now, forced_offline: true });
    } catch (err) {
        return res.status(500).json({ ok: false, error: 'worker_shutdown_failed', detail: err.message });
    }
});

/**
 * POST /partner-api/worker/sync-com-ports
 * body: { portas: ["COM3","COM5"] } — portas COM actualmente presentes no Windows.
 * Marca OFFLINE (e last_ping) todos os chips desta API key cujo nome de porta não está na lista.
 */
router.post('/worker/sync-com-ports', async (req, res) => {
    const supabase = req.app.get('supabase');
    const keyId = req.partner.api_key_id;
    const raw = req.body && req.body.portas;
    const list = Array.isArray(raw) ? raw : [];
    const present = new Set(
        list.map((p) => String(p || '').trim().toUpperCase()).filter(Boolean)
    );
    try {
        const polosScope = await listPolosFromPartner(supabase, req.partner.id);
        if (!polosScope.ok) return res.status(polosScope.status).json(polosScope.body);
        const poloIds = polosScope.polos.map((p) => p.id);
        if (!poloIds.length) {
            return res.json({ ok: true, marked_offline: 0, present: [...present] });
        }

        const { data: rows, error } = await supabase
            .from('chips')
            .select('id, porta')
            .in('polo_id', poloIds)
            .eq('registered_by_api_key_id', keyId);

        if (error) {
            return res.status(500).json({ ok: false, error: 'chip_list_failed', detail: error.message });
        }

        const toOff = (rows || [])
            .filter((c) => {
                const up = String(c.porta || '').trim().toUpperCase();
                return up && !present.has(up);
            })
            .map((c) => c.id);

        if (!toOff.length) {
            return res.json({ ok: true, marked_offline: 0, present: [...present] });
        }

        const now = new Date().toISOString();
        const { error: uErr } = await supabase
            .from('chips')
            .update({ status: 'offline', last_ping: now })
            .in('id', toOff);

        if (uErr) {
            return res.status(500).json({ ok: false, error: 'ghost_offline_failed', detail: uErr.message });
        }
        return res.json({ ok: true, marked_offline: toOff.length, present: [...present] });
    } catch (err) {
        return res.status(500).json({ ok: false, error: 'sync_com_ports_failed', detail: err.message });
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
