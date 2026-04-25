const { createClient } = require('@supabase/supabase-js');

// These are from app.js
const SUPABASE_URL = 'https://ewwhywbwtqwtuujemtfk.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV3d2h5d2J3dHF3dHV1amVtdGZrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYwOTAzMjYsImV4cCI6MjA5MTY2NjMyNn0.pgv9mkWHlq6wam7-BrN-zmlNDgyf-sDFTc1KT8IjvuU';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON);

async function checkDB() {
    console.log("Checking Chips...");
    const { count: idleChips, error: errorChips } = await supabase.from('chips').select('*', { count: 'exact', head: true }).eq('status', 'idle');
    console.log("Idle Chips:", idleChips);
    if (errorChips) console.error("Error Chips:", errorChips);

    console.log("Checking Polos...");
    const { data: polos, error: errorPolos } = await supabase.from('polos').select('*');
    console.log("Polos:", polos?.map(p => ({ id: p.id, status: p.status, last_seen: p.ultima_comunicacao })));

    console.log("Checking Services...");
    const { data: services, error: errorServices } = await supabase.from('services_config').select('*');
    console.log("Services count:", services?.length);
}

checkDB();
