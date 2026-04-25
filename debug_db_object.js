const { chromium } = require('playwright');

(async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    
    console.log('--- DEBUGGING DB OBJECT INSIDE BROWSER ---');
    
    page.on('console', msg => console.log('BROWSER LOG:', msg.text()));

    try {
        await page.goto('https://fluxsms-staging-production.up.railway.app', { waitUntil: 'networkidle' });
        
        await page.evaluate(() => {
            console.log('Testing db object...');
            if (typeof db === 'undefined') {
                console.log('db is UNDEFINED');
            } else if (db === null) {
                console.log('db is NULL');
            } else {
                console.log('db type:', typeof db);
                console.log('db keys:', Object.keys(db));
                console.log('db.rpc type:', typeof db.rpc);
                console.log('db.from type:', typeof db.from);
                console.log('window.supabase type:', typeof window.supabase);
            }
        });

    } catch (err) {
        console.error('Error:', err.message);
    } finally {
        await browser.close();
    }
})();
