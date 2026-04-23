Instalador público do FluxSMS Desktop (parceiros).

URL canónica em produção:
  https://fluxsms.com.br/download/FluxSMS_Setup.exe

Como atualizar o ficheiro:
  1. Gere: cd polo-worker-draft && npm run build-exe
  2. O FluxSMS_Setup.exe sai para esta pasta. Faça deploy (Railway / Git).
Instalação: o app usa o mesmo ficheiro de configuração do electron-store (nome fluxsms-desktop)
  — atualizar o instalador por cima (NSIS) mantém o login, desde que a chave de instalação seja a mesma.
Segurança: se o Windows pedir "Sim" na 1.ª abertura, é normal para acesso a portas COM.
Pode excluir o instalador do Windows Defender (opcional) se a equipa de TI aceitar.
