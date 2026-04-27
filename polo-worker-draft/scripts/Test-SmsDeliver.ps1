<#
.SYNOPSIS
  Testa POST /sms/deliver no backend (sem abrir porta COM — só HTTPS).

.DESCRIPTION
  O EXE/modem normalmente entrega SMS assim; este script replica para validar
  ativação em `waiting`, chave API e rede. Não interfere com o FluxSMS Desktop.

  O evento discarded com reason=activation_not_waiting acontece quando o
  activation_id não está em status `waiting` (ex.: teste antigo 39fea275-...).

.PARAMETER BackendUrl
  Ex.: https://fluxsms.com.br

.PARAMETER ApiKey
  Partner API key (flux_partner_...) OU HARDWARE_API_KEY do Railway — o mesmo
  que o worker Python usaria em PARTNER_API_KEY / HARDWARE.

.PARAMETER ActivationId
  UUID da linha em `activations` com status = waiting (ex.: ebd2688d-...).

.PARAMETER SmsCode
  Código de teste (ex.: 123456).

.EXAMPLE
  $env:FLUXSMS_API_KEY = 'flux_partner_....'
  .\Test-SmsDeliver.ps1 -ActivationId 'ebd2688d-c06c-4757-bcaa-6a59558fb779' -SmsCode '123456'
#>
[CmdletBinding()]
param(
    [string] $BackendUrl = $(if ($env:FLUXSMS_BACKEND) { $env:FLUXSMS_BACKEND } else { 'https://fluxsms.com.br' }),
    [string] $ApiKey = $env:FLUXSMS_API_KEY,
    [Parameter(Mandatory = $false)]
    [string] $ActivationId = 'ebd2688d-c06c-4757-bcaa-6a59558fb779',
    [string] $SmsCode = '123456',
    [string] $ChipPorta = $null
)

$ErrorActionPreference = 'Stop'
$base = $BackendUrl.TrimEnd('/')
if (-not $ApiKey -or $ApiKey.Length -lt 10) {
    Write-Host 'Defina a chave antes de correr, por exemplo:' -ForegroundColor Yellow
    Write-Host '  `$env:FLUXSMS_API_KEY = ''flux_partner_...''' -ForegroundColor Gray
    Write-Host '  ou a HARDWARE_API_KEY do Railway, se for essa a rota configurada.' -ForegroundColor Gray
    exit 1
}

$uri = "$base/sms/deliver"
$bodyObj = @{
    activation_id = $ActivationId
    sms_code      = $SmsCode
}
if ($ChipPorta) { $bodyObj.chip_porta = $ChipPorta }
$json = $bodyObj | ConvertTo-Json -Compress

Write-Host "POST $uri" -ForegroundColor Cyan
Write-Host "Body: $json" -ForegroundColor DarkGray

try {
    $response = Invoke-RestMethod -Uri $uri -Method Post -ContentType 'application/json' -Headers @{
        'x-api-key' = $ApiKey
    } -Body $json -TimeoutSec 30
    Write-Host 'Resposta:' -ForegroundColor Green
    $response | ConvertTo-Json -Depth 5
} catch {
    $status = $_.Exception.Response.StatusCode.value__
    Write-Host "HTTP $status" -ForegroundColor Red
    try {
        $reader = [System.IO.StreamReader]::new($_.Exception.Response.GetResponseStream())
        $txt = $reader.ReadToEnd()
        Write-Host $txt
    } catch {
        Write-Host $_.Exception.Message
    }
    exit 2
}

Write-Host ''
Write-Host 'Se ok=true, confirma no Supabase: activations.status=received e sms_code preenchido.' -ForegroundColor DarkCyan
Write-Host 'Se 401: chave errada ou revogada. Se 409 activation_not_waiting: id já não está waiting.' -ForegroundColor DarkCyan
