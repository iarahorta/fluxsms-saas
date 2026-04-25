const express = require('express');

const router = express.Router();

async function requireFluxAdmin(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
  if (!token) return res.status(401).json({ ok: false, error: 'missing_token' });

  const supabase = req.app.get('supabase');
  try {
    const { data: userData, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userData?.user) {
      return res.status(401).json({ ok: false, error: 'invalid_token' });
    }

    const { data: profile, error: profErr } = await supabase
      .from('profiles')
      .select('is_admin')
      .eq('id', userData.user.id)
      .maybeSingle();

    if (profErr || !profile?.is_admin) {
      return res.status(403).json({ ok: false, error: 'forbidden' });
    }

    req.adminUserId = userData.user.id;
    return next();
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'auth_check_failed', detail: err.message });
  }
}

router.use(requireFluxAdmin);

router.get('/health', (_req, res) => {
  return res.json({ ok: true, service: 'admin-financas-flux' });
});

// Fallback seguro para manter compatibilidade de rotas enquanto o módulo completo é restaurado.
router.all('*', (_req, res) => {
  return res.status(501).json({
    ok: false,
    error: 'not_implemented',
    detail: 'Módulo adminFinancasFlux em modo de compatibilidade temporária.'
  });
});

module.exports = router;
