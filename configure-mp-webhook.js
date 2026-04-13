#!/usr/bin/env node
/**
 * FluxSMS - Configurador Automático de Webhooks via Mercado Pago API
 * 
 * Este script configura o webhook do Mercado Pago para apontar para
 * o backend do FluxSMS automaticamente.
 * 
 * Uso: node configure-mp-webhook.js
 * Requisito: MP_ACCESS_TOKEN e BACKEND_URL no ambiente
 */

const https = require('https');

const ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
const BACKEND_URL  = process.env.BACKEND_URL || 'https://api.fluxsms.com.br';
const WEBHOOK_URL  = `${BACKEND_URL}/webhook/mercadopago`;

if (!ACCESS_TOKEN) {
    console.error('❌ ERRO: MP_ACCESS_TOKEN não definido.');
    console.error('   Execute: set MP_ACCESS_TOKEN=APP_USR-... && node configure-mp-webhook.js');
    process.exit(1);
}

// ─── Helper para chamadas à API do MP ──────────────────────
function mpRequest(method, path, body = null) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'api.mercadopago.com',
            path,
            method,
            headers: {
                'Authorization': `Bearer ${ACCESS_TOKEN}`,
                'Content-Type': 'application/json',
                'User-Agent': 'FluxSMS/1.0'
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, body: JSON.parse(data) });
                } catch {
                    resolve({ status: res.statusCode, body: data });
                }
            });
        });

        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

async function main() {
    console.log('╔══════════════════════════════════════════╗');
    console.log('║   FluxSMS - Configurador Mercado Pago    ║');
    console.log('╚══════════════════════════════════════════╝\n');

    // 1. Valida credenciais
    console.log('[1/3] Validando credenciais...');
    const userRes = await mpRequest('GET', '/users/me');
    if (userRes.status !== 200) {
        console.error('❌ Token inválido:', userRes.body?.message);
        process.exit(1);
    }
    const user = userRes.body;
    console.log(`  ✅ Conta: ${user.first_name} ${user.last_name} (${user.email})`);
    console.log(`  📋 User ID: ${user.id}\n`);

    // 2. Configura o Webhook
    console.log('[2/3] Configurando Webhook...');
    console.log(`  🎯 URL alvo: ${WEBHOOK_URL}`);

    const webhookPayload = {
        url: WEBHOOK_URL,
        active: true,
        events: ['payment']     // Só eventos de pagamento
    };

    // Tenta listar webhooks existentes
    const listRes = await mpRequest('GET', '/v1/webhooks');

    let webhookConfigured = false;

    if (listRes.status === 200 && listRes.body.data) {
        // Verifica se já existe configurado
        const existing = listRes.body.data.find(w => w.url === WEBHOOK_URL);

        if (existing) {
            // Atualiza o existente
            const updateRes = await mpRequest('PUT', `/v1/webhooks/${existing.id}`, webhookPayload);
            if (updateRes.status === 200) {
                console.log(`  ✅ Webhook atualizado (ID: ${existing.id})`);
                webhookConfigured = true;
            }
        }
    }

    if (!webhookConfigured) {
        // Cria novo webhook
        const createRes = await mpRequest('POST', '/v1/webhooks', webhookPayload);
        if (createRes.status === 201 || createRes.status === 200) {
            console.log(`  ✅ Webhook criado (ID: ${createRes.body.id})`);
        } else {
            console.warn(`  ⚠️  Webhook via API v1 falhou. Tente configurar manualmente em:`);
            console.warn(`     https://www.mercadopago.com.br/developers/panel/app`);
            console.warn(`  URL para configurar: ${WEBHOOK_URL}`);
        }
    }

    // 3. Exibe resumo e próximos passos
    console.log('\n[3/3] Resumo da Configuração:');
    console.log('──────────────────────────────────────────');
    console.log(`  MP User ID:    ${user.id}`);
    console.log(`  Webhook URL:   ${WEBHOOK_URL}`);
    console.log(`  Evento:        payment (approved/pending/rejected)`);
    console.log('──────────────────────────────────────────');
    console.log('\n✅ Configuração concluída!');
    console.log('\n📌 Próximos passos:');
    console.log('   1. Adicione MP_ACCESS_TOKEN ao GitHub Secrets');
    console.log('   2. Confirme que BACKEND_URL está apontando para o Railway');
    console.log(`   3. Teste: POST ${WEBHOOK_URL}`);
    console.log(`\n   Seu MP_USER_ID para usar no metadata dos pagamentos: ${user.id}`);
}

main().catch(err => {
    console.error('❌ Erro fatal:', err.message);
    process.exit(1);
});
