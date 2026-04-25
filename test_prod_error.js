const { chromium } = require('playwright');

(async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    
    page.on('console', msg => console.log('PAGE LOG:', msg.text()));
    page.on('pageerror', error => console.log('PAGE ERROR:', error.message));
    page.on('requestfailed', request => {
        console.log('FAILED REQUEST:', request.url(), request.failure().errorText);
    });

    page.on('dialog', async dialog => {
        console.log('ALERT FOUND:', dialog.message());
        await dialog.dismiss();
    });

    console.log('Navigating to https://fluxsms.com.br...');
    await page.goto('https://fluxsms.com.br', { waitUntil: 'load' });
    
    console.log('Attempting login...');
    await page.evaluate(() => {
        const u = document.getElementById('auth-email');
        const p = document.getElementById('auth-password');
        if (u && p) {
            u.value = 'iarachorta@gmail.com';
            p.value = '23112007';
            handleAuth('login');
        } else {
            console.log('LOGIN FIELDS NOT FOUND');
        }
    });

    console.log('Waiting 10 seconds for any alerts/errors...');
    await page.waitForTimeout(10000);
    
    await browser.close();
})();
