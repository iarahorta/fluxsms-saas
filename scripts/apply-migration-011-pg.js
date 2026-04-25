/**
 * Aplica a migração 011 via Postgres direto (quando o Supabase CLI não está linkado).
 * Defina no .env uma connection string URI, por exemplo:
 *   DATABASE_URL=postgresql://postgres.[ref]:[PASSWORD]@aws-0-eu-central-1.pooler.supabase.com:6543/postgres
 * (copie de Supabase → Project Settings → Database → Connection string → URI)
 *
 * Uso: node scripts/apply-migration-011-pg.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const url = process.env.DATABASE_URL || process.env.DIRECT_POSTGRES_URL;
if (!url) {
    console.error('Defina DATABASE_URL ou DIRECT_POSTGRES_URL no .env (connection string Postgres do Supabase).');
    process.exit(1);
}

async function main() {
    const sqlPath = path.join(__dirname, '..', 'supabase', 'migrations', '011_partner_chip_last_ping.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');
    const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
    await client.connect();
    try {
        await client.query(sql);
        console.log('Migração 011 aplicada com sucesso.');
    } finally {
        await client.end();
    }
}

main().catch((e) => {
    console.error(e.message || e);
    process.exit(1);
});
