const pdfModule = require('pdf-parse');
const pdf = typeof pdfModule === 'function' ? pdfModule : pdfModule.default;
const fs = require('fs');

const buffer = fs.readFileSync('C:/Users/user/Desktop/Export_GSM_Codder/briefing_operacao_72h_fluxsms.pdf');
pdf(buffer).then(data => {
    console.log(data.text);
}).catch(err => {
    console.error('Erro:', err.message);
});
