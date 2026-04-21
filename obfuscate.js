const JavaScriptObfuscator = require('javascript-obfuscator');
const fs = require('fs');
const path = require('path');

// Fontes agora ficam na pasta protegida
const filesToObfuscate = [
    { in: '_source_code_protected_/app.js', out: 'app.shield.js' },
    { in: '_source_code_protected_/admin.js', out: 'admin.shield.js' }
];

const distDir = path.join(__dirname, 'dist');
if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir);
}

// Configurações "MILITARY GRADE"
const obfuscationOptions = {
    compact: true,
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 1,
    deadCodeInjection: true,
    deadCodeInjectionThreshold: 1,
    debugProtection: true,
    debugProtectionInterval: 2500,
    disableConsoleOutput: true,
    identifierNamesGenerator: 'hexadecimal',
    log: false,
    numbersToExpressions: true,
    renameGlobals: false, // Mantido false para não quebrar os onclick do HTML
    selfDefending: true,
    splitStrings: true,
    splitStringsChunkLength: 5,
    stringArray: true,
    stringArrayEncoding: ['base64'],
    stringArrayThreshold: 1,
    transformObjectKeys: false, // 🛡️ Desativado para não quebrar chain de métodos do Supabase (from, select, etc)
    unicodeEscapeSequence: true,
    sourceMap: false
};

console.log('🛡️ Iniciando Ofuscação de Produção V2 (REFORÇADA)...');

filesToObfuscate.forEach(file => {
    const inputPath = path.join(__dirname, file.in);
    const outputPath = path.join(distDir, file.out);

    if (fs.existsSync(inputPath)) {
        console.log(`[Blindando] ${file.in} -> dist/${file.out}`);
        const code = fs.readFileSync(inputPath, 'utf8');
        const obfuscationResult = JavaScriptObfuscator.obfuscate(code, obfuscationOptions);
        fs.writeFileSync(outputPath, obfuscationResult.getObfuscatedCode());
    } else {
        console.error(`[ERRO] Arquivo fonte não encontrado: ${file.in}`);
    }
});

console.log('✅ Blindagem concluída com sucesso! Os arquivos .shield.js estão na pasta /dist');
