function clientIp(req) {
  const xff = req?.headers?.['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) {
    return xff.split(',')[0].trim();
  }
  return (
    req?.headers?.['cf-connecting-ip'] ||
    req?.ip ||
    req?.socket?.remoteAddress ||
    null
  );
}

function ua(req) {
  return String(req?.headers?.['user-agent'] || '');
}

async function logBalanceAudit(supabase, payload) {
  if (!supabase || !payload) return;

  const row = {
    event_type: String(payload.event_type || 'balance_audit'),
    gateway: payload.gateway ? String(payload.gateway) : null,
    external_ref: payload.external_ref ? String(payload.external_ref) : null,
    beneficiary_user_id: payload.beneficiary_user_id || null,
    amount: Number(payload.amount || 0),
    actor_ip: payload.actor_ip || null,
    user_agent: payload.user_agent ? String(payload.user_agent) : null,
    meta: payload.meta || {}
  };

  try {
    const { error } = await supabase.from('balance_audit_logs').insert(row);
    if (error) {
      // Fallback silencioso para ambientes sem tabela criada.
      console.warn('[audit] insert balance_audit_logs falhou:', error.message);
    }
  } catch (err) {
    console.warn('[audit] excecao logBalanceAudit:', err?.message || err);
  }
}

module.exports = { logBalanceAudit, clientIp, ua };
