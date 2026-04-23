Esta pasta é usada apenas em desenvolvimento local pelo electron-builder (artefatos pesados).

Em produção o instalador é servido a partir de:
  public/download/FluxSMS_Setup.exe

URL pública:
  https://fluxsms.com.br/download/FluxSMS_Setup.exe

O upload Railway ignora esta pasta via .railwayignore para não enviar win-unpacked nem duplicar o .exe.

Alternativa: defina POLO_WORKER_DOWNLOAD_URL com um URL absoluto (CDN, S3, etc.).
