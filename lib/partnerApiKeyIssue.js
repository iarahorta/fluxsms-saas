const crypto = require('crypto');
const { encryptPartnerApiKeyPlain } = require('./partnerKeyVault');

function generatePlainPartnerKey() {
    return `flux_partner_${crypto.randomBytes(24).toString('hex')}`;
}

async function insertNewActiveKey(supabase, partnerProfileId, label, resetHwid) {
    const plain = generatePlainPartnerKey();
    const keyHash = crypto.createHash('sha256').update(plain).digest('hex');
    const keyPrefix = plain.slice(0, 14);
    const vault = encryptPartnerApiKeyPlain(plain);

    const payload = {
        partner_id: partnerProfileId,
        key_hash: keyHash,
        key_prefix: keyPrefix,
        label: String(label || 'FluxSMS').slice(0, 120),
        is_active: true
    };
    if (vault) {
        payload.secret_ciphertext = vault.ciphertext;
        payload.secret_iv = vault.iv;
        payload.secret_tag = vault.tag;
    }
    if (resetHwid !== false) {
        payload.bound_hwid = null;
    }

    const { data: row, error } = await supabase
        .from('partner_api_keys')
        .insert(payload)
        .select('id, key_prefix, label, created_at')
        .maybeSingle();
    if (error) throw new Error(error.message);
    return { plain, row };
}

/**
 * Garante uma chave ativa. Se já existir, não altera (plain null).
 */
async function ensurePartnerApiKey(supabase, partnerProfileId, label) {
    const { data: active } = await supabase
        .from('partner_api_keys')
        .select('id, key_prefix')
        .eq('partner_id', partnerProfileId)
        .eq('is_active', true)
        .maybeSingle();
    if (active) {
        return { plain: null, row: active, created: false };
    }
    const { plain, row } = await insertNewActiveKey(supabase, partnerProfileId, label, true);
    return { plain, row, created: true };
}

/**
 * Desativa chaves ativas e emite nova (admin / rotação).
 */
async function rotatePartnerApiKey(supabase, partnerProfileId, label) {
    await supabase
        .from('partner_api_keys')
        .update({ is_active: false })
        .eq('partner_id', partnerProfileId)
        .eq('is_active', true);
    return insertNewActiveKey(supabase, partnerProfileId, label, true);
}

module.exports = {
    ensurePartnerApiKey,
    rotatePartnerApiKey,
    generatePlainPartnerKey
};
