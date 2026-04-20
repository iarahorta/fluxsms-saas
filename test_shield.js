const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({ headless: "new" });
  const page = await browser.newPage();
  
  console.log('--- TESTE DE BLINDAGEM LIVE ---');
  
  // 1. Tentar acessar arquivos proibidos
  const forbiddenUrls = [
    'https://fluxsms.com.br/src/app.js',
    'https://fluxsms.com.br/supabase/config.toml',
    'https://fluxsms.com.br/routes/sms.js',
    'https://fluxsms.com.br/dist/main.bundle.js'
  ];

  for (const url of forbiddenUrls) {
      const response = await page.goto(url);
      console.log(`URL: ${url} -> Status: ${response.status()}`);
  }

  // 2. Analisar o conteúdo do main bundle
  await page.goto('https://fluxsms.com.br/dist/index.shield.js');
  const content = await page.content();
  const hasFunction = content.includes('function ') || content.includes('const ') || content.includes('supabase');
  console.log(`Verificação Ilegibilidade (index.shield.js): ${hasFunction ? 'FALHOU (Legível)' : 'SUCESSO (Blindado)'}`);

  await browser.close();
})();
