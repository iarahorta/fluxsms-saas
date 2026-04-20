const JavaScriptObfuscator = require('javascript-obfuscator');
const fs = require('fs');
const path = require('path');

const filesToObfuscate = [
    { in: 'app.js', out: 'app.js' }, // Sobrescrevendo o original após criar um backup seria arriscado, vamos criar uma pasta 'dist'
    { in: 'admin.js', out: 'admin.js' }
];

const distDir = path.join(__dirname, 'dist');
if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir);
}

const obfuscationOptions = {
    compact: true,
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 1,
    numbersToExpressions: true,
    simplify: true,
    stringArrayThreshold: 1,
    splitStrings: true,
    splitStringsChunkLength: 10,
    unicodeEscapeSequence: true,
    renameGlobals: false, // Perigoso se houver chamadas inline no HTML, vamos deixar false ou mapear
    identifierNamesGenerator: 'hexadecimal',
    debugProtection: true,
    debugProtectionInterval: 4000,
    disableConsoleOutput: true,
    selfDefending: true,
    sourceMap: false // Desativar source maps completamente
};

console.log('🚀 Iniciando Ofuscação de Produção...');

filesToObfuscate.forEach(file => {
    const inputPath = path.join(__dirname, file.in);
    const outputPath = path.join(distDir, file.out);

    if (fs.existsSync(inputPath)) {
        console.log(`[Ofuscando] ${file.in} -> dist/${file.out}`);
        const code = fs.readFileSync(inputPath, 'utf8');
        const obfuscationResult = JavaScriptObfuscator.obfuscate(code, obfuscationOptions);
        fs.writeFileSync(outputPath, obfuscationResult.getObfuscatedCode());
    } else {
        console.warn(`[Aviso] Arquivo não encontrado: ${file.in}`);
    }
});

console.log('✅ Ofuscação concluída com sucesso! Os arquivos estão na pasta /dist');
