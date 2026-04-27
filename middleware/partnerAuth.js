const crypto = require('crypto');

function normalizeIp(ip) {
  if (!ip) return '';
  if (ip.startsWith('::ffff:')) return ip.replace('::ffff:', '');
  return ip;
}

function ipToLong(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
  return ((nums[0] << 24) >>> 0) + ((nums[1] << 16) >>> 0) + ((nums[2] << 8) >>> 0) + nums[3];
}

function ipInCidr(ip, cidr) {
  const [range, prefixRaw] = cidr.split('/');
  const prefix = Number(prefixRaw);
  const ipLong = ipToLong(ip);
  const rangeLong = ipToLong(range);
  if (ipLong === null || rangeLong === null || Number.isNaN(prefix) || prefix < 0 || prefix > 32) return false;
  const mask = prefix === 0 ? 0 : ((0xffffffff << (32 - prefix)) >>> 0);
  return (ipLong & mask) === (rangeLong & mask);
}

function buildPartnerAuth({ supabase }) {
  return async function partnerAuth(req, res, next) {
    try {
      const authHeader = req.headers.authorization || '';
      const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
      const apiKey = req.headers['x-api-key'] || bearer;
      if (!apiKey) return res.status(401).json({ ok: false, error: 'api_key_required' });

      const keyHash = crypto.createHash('sha256').update(String(apiKey)).digest('hex');
      const nowIso = new Date().toISOString();
      let keyRow = null;
      let keyError = null;

      // Caminho principal: esquema novo (key_hash + is_active).
      ({ data: keyRow, error: keyError } = await supabase
        .from('partner_api_keys')
        .select('id, partner_id, is_active, expires_at, bound_hwid')
        .eq('key_hash', keyHash)
        .eq('is_active', true)
        .or(`expires_at.is.null,expires_at.gt.${nowIso}`)
        .maybeSingle());

      // Fallback 1: coluna is_active ausente (base legada).
      if (keyError && String(keyError.message || '').toLowerCase().includes('is_active')) {
        const legacyNoActive = await supabase
          .from('partner_api_keys')
          .select('id, partner_id, expires_at, bound_hwid, status')
          .eq('key_hash', keyHash)
          .or(`expires_at.is.null,expires_at.gt.${nowIso}`)
          .maybeSingle();
        keyRow = legacyNoActive.data;
        keyError = legacyNoActive.error;
        if (!keyError && keyRow && keyRow.status && String(keyRow.status).toUpperCase() !== 'ACTIVE') {
          keyRow = null;
        }
      }

      // Fallback 2: chave em texto puro (api_key) em base mais antiga.
      if ((!keyRow && !keyError) || (keyError && String(keyError.message || '').toLowerCase().includes('key_hash'))) {
        const legacyPlain = await supabase
          .from('partner_api_keys')
          .select('id, partner_id, expires_at, bound_hwid, status, is_active')
          .eq('api_key', String(apiKey))
          .or(`expires_at.is.null,expires_at.gt.${nowIso}`)
          .maybeSingle();
        if (!legacyPlain.error && legacyPlain.data) {
          const row = legacyPlain.data;
          if (Object.prototype.hasOwnProperty.call(row, 'is_active') && row.is_active === false) {
            keyRow = null;
          } else if (row.status && String(row.status).toUpperCase() !== 'ACTIVE') {
            keyRow = null;
          } else {
            keyRow = row;
            keyError = null;
          }
        } else if (legacyPlain.error && !keyError) {
          keyError = legacyPlain.error;
        }
      }

      if (keyError || !keyRow) return res.status(401).json({ ok: false, error: 'api_key_invalid' });

      const hwid = String(
        req.headers['x-flux-hwid'] ||
        req.headers['x-flux-hw-id'] ||
        req.headers['x-hardware-id'] ||
        ''
      ).trim();
      // Chave sem HWID vinculado: basta API key. Chave já vinculada: exige X-Flux-Hwid correto.
      if (keyRow.bound_hwid) {
        if (!hwid || hwid.length < 16) {
          return res.status(400).json({
            ok: false,
            error: 'hwid_required',
            hint: 'Esta chave está vinculada a um PC. Envie o header X-Flux-Hwid do instalador desktop.'
          });
        }
        if (keyRow.bound_hwid !== hwid) {
          return res.status(403).json({ ok: false, error: 'hwid_mismatch', detail: 'Esta chave já está vinculada a outro computador.' });
        }
      } else if (hwid.length >= 16) {
        const { data: boundRows, error: bindErr } = await supabase
          .from('partner_api_keys')
          .update({ bound_hwid: hwid })
          .eq('id', keyRow.id)
          .is('bound_hwid', null)
          .select('bound_hwid');
        if (bindErr) {
          return res.status(500).json({ ok: false, error: 'hwid_bind_failed', detail: bindErr.message });
        }
        if (!boundRows || boundRows.length === 0) {
          const { data: rec } = await supabase
            .from('partner_api_keys')
            .select('bound_hwid')
            .eq('id', keyRow.id)
            .maybeSingle();
          if (!rec || rec.bound_hwid !== hwid) {
            return res.status(403).json({ ok: false, error: 'hwid_mismatch', detail: 'Esta chave já está vinculada a outro computador.' });
          }
        }
      }

      const { data: partner, error: partnerError } = await supabase
        .from('partner_profiles')
        .select('id, user_id, status, partner_code')
        .eq('id', keyRow.partner_id)
        .eq('status', 'active')
        .maybeSingle();

      if (partnerError || !partner) return res.status(403).json({ ok: false, error: 'partner_inactive' });

      const { data: allowList, error: allowError } = await supabase
        .from('partner_ip_allowlist')
        .select('ip_or_cidr')
        .eq('partner_id', partner.id)
        .eq('is_active', true);

      if (allowError) return res.status(500).json({ ok: false, error: 'allowlist_check_failed' });

      const callerIpRaw = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || '';
      const callerIp = normalizeIp(callerIpRaw);
      const rules = (allowList || []).map((x) => String(x.ip_or_cidr).trim()).filter(Boolean);

      if (rules.length > 0) {
        const allowed = rules.some((rule) => {
          if (rule.includes('/')) return ipInCidr(callerIp, rule);
          return normalizeIp(rule) === callerIp;
        });
        if (!allowed) return res.status(403).json({ ok: false, error: 'ip_not_allowed', ip: callerIp });
      }

      await supabase
        .from('partner_api_keys')
        .update({ last_used_at: new Date().toISOString() })
        .eq('id', keyRow.id);

      req.partner = {
        id: partner.id,
        user_id: partner.user_id,
        partner_code: partner.partner_code,
        api_key_id: keyRow.id,
        ip: callerIp
      };

      return next();
    } catch (err) {
      return res.status(500).json({ ok: false, error: 'partner_auth_internal', detail: err.message });
    }
  };
}

module.exports = { buildPartnerAuth };
