param(
    [Parameter(Mandatory = $true)] [string] $CloudflareApiToken,
    [Parameter(Mandatory = $true)] [string] $ZoneId,
    [string] $DkimValue = ""
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($CloudflareApiToken) -or $CloudflareApiToken -match "SEU_TOKEN|TOKEN_CF") {
    throw "CloudflareApiToken inválido. Passe um token real da Cloudflare."
}
if ([string]::IsNullOrWhiteSpace($ZoneId) -or $ZoneId -match "SEU_ZONE_ID|ZONE_ID") {
    throw "ZoneId inválido. Passe o Zone ID real da zona fluxsms.com.br."
}

$Headers = @{
    Authorization = "Bearer $CloudflareApiToken"
    "Content-Type" = "application/json"
}

function Upsert-DnsRecord {
    param(
        [string]$Type,
        [string]$Name,
        [string]$Content,
        [int]$Priority = 0
    )

    $listUrl = "https://api.cloudflare.com/client/v4/zones/$ZoneId/dns_records?type=$Type&name=$Name"
    $existing = Invoke-RestMethod -Method Get -Uri $listUrl -Headers $Headers
    $record = $null
    if ($Type -eq "MX") {
        $record = $existing.result | Where-Object { $_.content -eq $Content -and [int]$_.priority -eq $Priority } | Select-Object -First 1
    } else {
        $record = $existing.result | Where-Object { $_.content -eq $Content } | Select-Object -First 1
    }

    $body = @{
        type = $Type
        name = $Name
        content = $Content
        ttl = 3600
    }
    if ($Type -eq "MX") {
        $body.priority = $Priority
    }
    $json = $body | ConvertTo-Json -Depth 5

    if ($record) {
        Write-Host "Já existe: $Type $Name -> $Content"
        return
    }

    $url = "https://api.cloudflare.com/client/v4/zones/$ZoneId/dns_records"
    $create = Invoke-RestMethod -Method Post -Uri $url -Headers $Headers -Body $json
    Assert-CfSuccess -Response $create -Context "criar $Type $Name"
    Write-Host "Criado: $Type $Name -> $Content"
}

function Assert-CfSuccess {
    param([object]$Response, [string]$Context)
    if (-not $Response.success) {
        $errs = ($Response.errors | ForEach-Object { "$($_.code): $($_.message)" }) -join " | "
        throw "Cloudflare API falhou em '$Context' => $errs"
    }
}

$zoneCheckUrl = "https://api.cloudflare.com/client/v4/zones/$ZoneId"
$zoneCheck = Invoke-RestMethod -Method Get -Uri $zoneCheckUrl -Headers $Headers
Assert-CfSuccess -Response $zoneCheck -Context "validar zone id"
Write-Host "Zona validada: $($zoneCheck.result.name)"

Upsert-DnsRecord -Type "MX" -Name "fluxsms.com.br" -Content "mx.zoho.com" -Priority 10
Upsert-DnsRecord -Type "MX" -Name "fluxsms.com.br" -Content "mx2.zoho.com" -Priority 20
Upsert-DnsRecord -Type "MX" -Name "fluxsms.com.br" -Content "mx3.zoho.com" -Priority 50
Upsert-DnsRecord -Type "TXT" -Name "fluxsms.com.br" -Content "v=spf1 include:zoho.com ~all"

$dkimName = "zoho._domainkey.fluxsms.com.br"
$dkimLookupUrl = "https://api.cloudflare.com/client/v4/zones/$ZoneId/dns_records?type=TXT&name=$dkimName"
$dkimExisting = Invoke-RestMethod -Method Get -Uri $dkimLookupUrl -Headers $Headers
if (($dkimExisting.result | Measure-Object).Count -gt 0) {
    Write-Host "DKIM já existe para zoho._domainkey."
} elseif ($DkimValue) {
    Upsert-DnsRecord -Type "TXT" -Name $dkimName -Content $DkimValue
} else {
    Write-Host "DKIM ausente. Passe -DkimValue com o valor do painel Zoho para criar automaticamente."
}

Write-Host "Concluído. Remetente oficial do sistema: suporte@fluxsms.com.br"
