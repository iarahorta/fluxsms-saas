const JavaScriptObfuscator = require('javascript-obfuscator');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const distDir = path.join(__dirname, 'dist');
if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir);
}

// 1. PHASE: BUNDLING (esbuild)
// Une Supabase SDK + app.js + admin.js em um único arquivo
console.log('📦 Iniciando Bundling (esbuild)...');
try {
    execSync('npx esbuild src/index.js --bundle --minify --outfile=dist/main.bundle.js --platform=browser');
    console.log('✅ Bundling concluído!');
} catch (e) {
    console.error('❌ Erro no Bundling:', e.message);
    process.exit(1);
}

// 2. PHASE: TOTAL OBFUSCATION
console.log('🛡️ Iniciando Blindagem Military Grade (Bundle Total)...');
const bundlePath = path.join(distDir, 'main.bundle.js');
const outputPath = path.join(distDir, 'index.shield.js');

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
    renameGlobals: false,
    selfDefending: true,
    splitStrings: true,
    splitStringsChunkLength: 5,
    stringArray: true,
    stringArrayEncoding: ['base64'],
    stringArrayThreshold: 1,
    transformObjectKeys: true,
    unicodeEscapeSequence: true,
    sourceMap: false
};

const code = fs.readFileSync(bundlePath, 'utf8');
const obfuscationResult = JavaScriptObfuscator.obfuscate(code, obfuscationOptions);
fs.writeFileSync(outputPath, obfuscationResult.getObfuscatedCode());

// Limpeza temporária
fs.unlinkSync(bundlePath);

console.log('✅ MEGA-BLINDAGEM concluída! Arquivo único: dist/index.shield.js');
