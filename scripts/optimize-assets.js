/**
 * Compacta imagens em assets/ e favicon.png na raiz.
 * Uso: npm run optimize:assets
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const root = path.join(__dirname, '..');
const assetsDir = path.join(root, 'assets');

/**
 * @param {{ inFile: string, outRaster: string, outWebp: string|null, resize: object|null, webpQuality: number, rasterFormat: 'png'|'jpeg' }} opts
 */
async function processOne({ inFile, outRaster, outWebp, resize, webpQuality, rasterFormat }) {
    if (!fs.existsSync(inFile)) {
        console.warn('Ignorado (não existe):', inFile);
        return;
    }
    const before = fs.statSync(inFile).size;
    const buf = fs.readFileSync(inFile);

    let r = sharp(buf).rotate();
    if (resize) r = r.resize(resize);
    if (rasterFormat === 'jpeg') {
        await r.jpeg({ quality: 82, mozjpeg: true }).toFile(outRaster + '.tmp');
    } else {
        await r.png({ compressionLevel: 9, adaptiveFiltering: true }).toFile(outRaster + '.tmp');
    }
    fs.renameSync(outRaster + '.tmp', outRaster);
    const afterR = fs.statSync(outRaster).size;

    if (outWebp) {
        let w = sharp(buf).rotate();
        if (resize) w = w.resize(resize);
        await w.webp({ quality: webpQuality }).toFile(outWebp);
        const wSize = fs.statSync(outWebp).size;
        console.log(path.basename(inFile), rasterFormat.toUpperCase(), before, '→', afterR, '| WebP', wSize);
    } else {
        console.log(path.basename(inFile), rasterFormat.toUpperCase(), before, '→', afterR);
    }
}

async function run() {
    const heroPng = path.join(assetsDir, 'hero_luxury.png');
    const heroJpg = path.join(assetsDir, 'hero_luxury.jpg');
    const heroIn = fs.existsSync(heroPng) ? heroPng : heroJpg;
    await processOne({
        inFile: heroIn,
        outRaster: path.join(assetsDir, 'hero_luxury.jpg'),
        outWebp: path.join(assetsDir, 'hero_luxury.webp'),
        resize: { width: 1400, withoutEnlargement: true },
        webpQuality: 82,
        rasterFormat: 'jpeg'
    });
    await processOne({
        inFile: path.join(assetsDir, 'logo.png'),
        outRaster: path.join(assetsDir, 'logo.png'),
        outWebp: path.join(assetsDir, 'logo.webp'),
        resize: { width: 400, withoutEnlargement: true },
        webpQuality: 85,
        rasterFormat: 'png'
    });
    await processOne({
        inFile: path.join(assetsDir, 'icon.png'),
        outRaster: path.join(assetsDir, 'icon.png'),
        outWebp: path.join(assetsDir, 'icon.webp'),
        resize: { width: 256, withoutEnlargement: true },
        webpQuality: 85,
        rasterFormat: 'png'
    });
    await processOne({
        inFile: path.join(root, 'favicon.png'),
        outRaster: path.join(root, 'favicon.png'),
        outWebp: null,
        resize: { width: 64, height: 64, fit: 'cover' },
        webpQuality: 80,
        rasterFormat: 'png'
    });
    console.log('Concluído.');
}

run().catch((e) => {
    console.error(e);
    process.exit(1);
});
