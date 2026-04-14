const { chromium } = require('playwright');
(async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    page.on('console', msg => console.log('BROWSER CONSOLE:', msg.text()));
    page.on('pageerror', err => console.log('BROWSER ERROR:', err.message));
    
    console.log("Acessando localhost...");
    await page.goto('http://localhost:8080');
    
    // Open modal
    await page.waitForSelector('.btn-login-header');
    await page.click('.btn-login-header');
    await page.waitForSelector('text=Criar conta');
    await page.click('text=Criar conta');
    await page.waitForSelector('#reg-name');
    
    console.log("Preenchendo formulário...");
    await page.fill('#reg-name', 'Julianna Horta');
    await page.fill('#reg-email', 'juativacoesms@gmail.com');
    await page.fill('#reg-password', 'testPassword123');
    
    page.on('dialog', async dialog => {
        console.log('=> JS DIALOG DISPARADO:', dialog.message());
        await dialog.accept();
    });
    
    console.log("Clicando no botão de cadastro...");
    await page.click('button:has-text("CADASTRAR GRATUITAMENTE")');
    await page.waitForTimeout(4000);
    console.log("Teste finalizado.");
    await browser.close();
})();
