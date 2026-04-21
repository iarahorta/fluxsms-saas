const crypto = require('crypto');

/** 32 bytes para AES-256-GCM. Preferir FLUX_PARTNER_KEY_ENCRYPTION_SECRET (64 hex). Fallback determinístico do service key (staging). */
function getMasterKeyBuffer() {
    const hex = process.env.FLUX_PARTNER_KEY_ENCRYPTION_SECRET;
    if (hex && /^[0-9a-fA-F]{64}$/.test(hex)) {
        return Buffer.from(hex, 'hex');
    }
    const svc = process.env.SUPABASE_SERVICE_KEY || '';
    return crypto.createHash('sha256').update('FLUX_PARTNER_VAULT_V1|' + svc).digest();
}

/**
 * @param {string} plain
 * @returns {{ ciphertext: string, iv: string, tag: string } | null}
 */
function encryptPartnerApiKeyPlain(plain) {
    if (!plain || typeof plain !== 'string') return null;
    try {
        const key = getMasterKeyBuffer();
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
        const tag = cipher.getAuthTag();
        return {
            ciphertext: enc.toString('base64'),
            iv: iv.toString('base64'),
            tag: tag.toString('base64')
        };
    } catch {
        return null;
    }
}

/**
 * @param {{ secret_ciphertext: string|null, secret_iv: string|null, secret_tag: string|null }} row
 * @returns {string|null}
 */
function decryptPartnerApiKeySecret(row) {
    if (!row?.secret_ciphertext || !row?.secret_iv || !row?.secret_tag) return null;
    try {
        const key = getMasterKeyBuffer();
        const iv = Buffer.from(row.secret_iv, 'base64');
        const tag = Buffer.from(row.secret_tag, 'base64');
        const data = Buffer.from(row.secret_ciphertext, 'base64');
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(tag);
        const out = Buffer.concat([decipher.update(data), decipher.final()]);
        return out.toString('utf8');
    } catch {
        return null;
    }
}

module.exports = {
    encryptPartnerApiKeyPlain,
    decryptPartnerApiKeySecret
};
