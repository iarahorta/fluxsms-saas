/**
 * Verifica se a migração 011 (last_ping em chips e partner_profiles) está aplicada no Supabase.
 * Uso: node scripts/verify-migration-011.js
 * Requer .env com SUPABASE_URL e SUPABASE_SERVICE_KEY.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { createClient } = require('@supabase/supabase-js');

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY;

async function main() {
    if (!url || !key) {
        console.error('Falta SUPABASE_URL ou SUPABASE_SERVICE_KEY no .env');
        process.exit(1);
    }
    const supabase = createClient(url, key);
    const checks = [
        { table: 'chips', column: 'last_ping' },
        { table: 'partner_profiles', column: 'last_ping' }
    ];
    let ok = true;
    for (const { table, column } of checks) {
        const { error } = await supabase.from(table).select(column).limit(1);
        if (error) {
            console.error(`[FALHA] ${table}.${column}:`, error.message);
            ok = false;
        } else {
            console.log(`[OK] ${table}.${column} — coluna acessível.`);
        }
    }
    process.exit(ok ? 0 : 2);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
