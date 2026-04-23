; FluxSMS Desktop — upgrade in-place sem desinstalação manual
; Encerra o executável antes de substituir ficheiros (evita locks e pedidos de desinstalar).
; AppData / electron-store não são tocados pelo instalador (deleteAppDataOnUninstall=false no package.json).

!macro customInit
  DetailPrint "FluxSMS: a encerrar a versão em execução (se existir)…"
  ; /T inclui filhos; 128 = processo não encontrado (instalação nova — ignorar)
  ExecWait '"$SYSDIR\cmd.exe" /c taskkill /F /IM "FluxSMS Desktop.exe" /T' $R0
  Sleep 1500
!macroend

!macro customUnInit
  DetailPrint "FluxSMS: a encerrar antes de remover…"
  ExecWait '"$SYSDIR\cmd.exe" /c taskkill /F /IM "FluxSMS Desktop.exe" /T' $R0
  Sleep 800
!macroend
