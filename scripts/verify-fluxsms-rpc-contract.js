#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function readUtf8(relativePath) {
  const fullPath = path.join(ROOT, relativePath);
  return fs.readFileSync(fullPath, 'utf8');
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function verifyFrontContract() {
  const appJs = readUtf8('_source_code_protected_/app.js');

  const helperExists = /function\s+callRpcSolicitarSmsV3ApenasQuatro\s*\(/.test(appJs);
  assert(
    helperExists,
    'Helper callRpcSolicitarSmsV3ApenasQuatro() não encontrado em _source_code_protected_/app.js.'
  );

  const rpcNameMatches = appJs.match(/rpc\(\s*['"]rpc_solicitar_sms_v3['"]/g) || [];
  assert(
    rpcNameMatches.length >= 1,
    "Chamada da RPC 'rpc_solicitar_sms_v3' não encontrada no front."
  );

  const expectedKeys = ['p_user_id', 'p_service', 'p_service_name', 'p_default_price'];
  const missingKeys = expectedKeys.filter((key) => !new RegExp(`${key}\\s*:`).test(appJs));
  assert(
    missingKeys.length === 0,
    `Front sem as chaves obrigatórias da RPC: ${missingKeys.join(', ')}.`
  );
}

function verifyCanonicalSqlContract() {
  const sql = readUtf8('supabase/SQL_PASTE_CANONICAL_rpc_solicitar_v3_4args.sql');

  assert(
    /CREATE OR REPLACE FUNCTION\s+public\.rpc_solicitar_sms_v3\s*\(\s*p_user_id UUID,\s*p_service TEXT,\s*p_service_name TEXT,\s*p_default_price NUMERIC\s*\)/is.test(
      sql
    ),
    'SQL canônico sem assinatura de 4 argumentos esperada para rpc_solicitar_sms_v3.'
  );

  assert(
    /GRANT EXECUTE ON FUNCTION\s+public\.rpc_solicitar_sms_v3\s*\(\s*UUID,\s*TEXT,\s*TEXT,\s*NUMERIC\s*\)\s+TO authenticated;/i.test(
      sql
    ),
    'SQL canônico sem GRANT EXECUTE esperado para assinatura de 4 argumentos.'
  );
}

function main() {
  verifyFrontContract();
  verifyCanonicalSqlContract();
  console.log('verify-fluxsms-rpc-contract: OK');
}

try {
  main();
} catch (error) {
  console.error('verify-fluxsms-rpc-contract: FALHOU');
  console.error(error.message);
  process.exit(1);
}
