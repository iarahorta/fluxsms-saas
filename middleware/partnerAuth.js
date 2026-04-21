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

      const { data: keyRow, error: keyError } = await supabase
        .from('partner_api_keys')
        .select('id, partner_id, is_active, expires_at')
        .eq('key_hash', keyHash)
        .eq('is_active', true)
        .or(`expires_at.is.null,expires_at.gt.${nowIso}`)
        .maybeSingle();

      if (keyError || !keyRow) return res.status(401).json({ ok: false, error: 'api_key_invalid' });

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
