const { chromium } = require('playwright');

(async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();
    
    console.log('--- TESTE DE SOLICITAÇÃO DE NÚMERO (STAGING) ---');
    
    page.on('console', msg => console.log('PAGE LOG:', msg.text()));
    page.on('pageerror', error => console.log('PAGE ERROR:', error.message));

    try {
        console.log('Navegando para Staging...');
        await page.goto('https://fluxsms-staging-production.up.railway.app', { waitUntil: 'networkidle' });

        console.log('Abrindo Modal de Login...');
        await page.click('button:has-text("Entrar")');
        await page.waitForSelector('#authModal', { state: 'visible' });

        console.log('Preenchendo credenciais...');
        await page.fill('#auth-email', 'iarahorta@gmail.com');
        await page.fill('#auth-password', '23112007');
        await page.click('button:has-text("Entrar no Sistema")');

        console.log('Aguardando carregamento do Dashboard...');
        await page.waitForSelector('#dashboard-view', { state: 'visible', timeout: 15000 });
        
        // Esperar carregar chips e saldo
        await page.waitForTimeout(3000); 

        const balance = await page.innerText('#balance-display');
        const stock = await page.innerText('#stock-count');
        console.log(`Saldo Detectado: ${balance}`);
        console.log(`Estoque Detectado: ${stock}`);

        console.log('Tentando clicar no botão SOLICITAR do WhatsApp...');
        const solicitarBtn = page.locator('.service-row:has-text("WhatsApp") .btn-buy');
        await solicitarBtn.click();

        console.log('Aguardando surgimento do card de ativação...');
        await page.waitForSelector('.session-card', { state: 'visible', timeout: 10000 });
        
        const number = await page.innerText('.session-card .number');
        console.log(`SUCESSO! Número capturado: ${number}`);

        await page.screenshot({ path: 'activation_success_proof.png' });
        console.log('Screenshot salvo: activation_success_proof.png');

    } catch (err) {
        console.error('FALHA NO TESTE:', err.message);
        await page.screenshot({ path: 'test_failure.png' });
    } finally {
        await browser.close();
    }
})();
