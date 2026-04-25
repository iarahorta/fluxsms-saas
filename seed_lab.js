// Script de Seed DEFINITIVO — usa SERVICE_KEY para bypassar RLS
// Roda pelo node localmente ou pela Railway via /debug/seed
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://ewwhywbwtqwtuujemtfk.supabase.co';
// Precisa da SERVICE_KEY (não a anon key) para bypassar RLS
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SERVICE_KEY) {
    console.error('ERRO: Defina a variável SUPABASE_SERVICE_KEY para rodar este script.');
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

async function seed() {
    console.log('🌱 Iniciando seed do Laboratório...');

    const POLO_ID = 'ba768131-e67e-4299-bf5a-96503f92076c';

    // 1. Polo ONLINE com data no futuro (imortal no dashboard) — manter chave existente
    const { error: poloError } = await supabase.from('polos').update({
        status: 'ONLINE',
        ultima_comunicacao: '2029-12-31T23:59:59.000Z'
    }).eq('id', POLO_ID);
    if (poloError) console.error('Polo error:', poloError); else console.log('✅ Polo OK');

    // 2. 10 chips de teste (portas 101-110 para não conflitar com hardware real)
    const chips = Array.from({ length: 10 }, (_, i) => ({
        id: `00000000-0000-0000-0002-${String(i + 1).padStart(12, '0')}`,
        polo_id: POLO_ID,
        numero: `+55119${String(i + 1).padStart(8, '0')}`,
        porta: 101 + i,  // portas 101-110, sem conflito com modems reais
        status: 'idle'
    }));

    const { error: chipsError } = await supabase.from('chips').upsert(chips, { onConflict: 'id' });
    if (chipsError) console.error('Chips error:', chipsError); else console.log(`✅ ${chips.length} chips OK`);

    // 3. Saldo do usuário master
    const { error: balanceError } = await supabase
        .from('profiles')
        .update({ balance: 500.00 })
        .eq('email', 'iarahorta@gmail.com');
    if (balanceError) console.error('Balance error:', balanceError); else console.log('✅ Saldo R$ 500 OK');

    console.log('🏁 Seed concluído!');
}

seed().catch(console.error);
