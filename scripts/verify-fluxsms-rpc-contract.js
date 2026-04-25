/**
 * Garante que a compra (rpc_solicitar_sms_v3) no app só passa
 * 4 parâmetros — alinhado a public.rpc_solicitar_sms_v3(uuid,text,text,numeric).
 * Um 5.º argumento no cliente, sem a função com essa assinatura na base, dá erro PGRST no PostgREST.
 */
const fs = require('fs');
const path = require('path');

const appPath = path.join(__dirname, '..', '_source_code_protected_', 'app.js');
const src = fs.readFileSync(appPath, 'utf8');

const err = (msg) => {
    console.error(`[verify-fluxsms-rpc-contract] FALHA: ${msg}`);
    process.exit(1);
};

if (/p_registered_by_api_key_id/.test(src)) {
    err('Não use p_registered_by_api_key_id no app; o contrato de produção é 4 parâmetros.');
}

const nCall = (src.match(/['"]rpc_solicitar_sms_v3['"]/g) || []).length;
if (nCall !== 1) {
    err(
        `Deve haver exactamente 1 ocorrência de "rpc_solicitar_sms_v3" (helper único). Encontrado: ${nCall}`
    );
}

const i = src.indexOf("'rpc_solicitar_sms_v3'");
if (i < 0) err('Não encontrei rpc_solicitar_sms_v3');

const sub = src.slice(i, i + 1500);
if (!/p_user_id:\s*userId/.test(sub) || !/p_default_price:\s*defaultPrice/.test(sub)) {
    err('Payload da RPC inesperado; use callRpcSolicitarSmsV3ApenasQuatro com userId e defaultPrice.');
}

console.log('[verify-fluxsms-rpc-contract] OK (4 parâmetros, uma chamada).');
