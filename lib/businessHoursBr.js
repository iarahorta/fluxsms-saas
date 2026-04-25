/**
 * Horário comercial padrão (Brasil): 07:00–18:00 em America/Sao_Paulo.
 * Pedidos fora desse intervalo são bloqueados.
 */
function isSaoPauloBusinessHours(date = new Date()) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Sao_Paulo',
        hour: '2-digit',
        hour12: false
    }).formatToParts(date);

    const hourPart = parts.find((p) => p.type === 'hour');
    const h = hourPart ? Number(hourPart.value) : NaN;
    if (!Number.isFinite(h)) return false;
    return h >= 7 && h < 18;
}

module.exports = { isSaoPauloBusinessHours };
