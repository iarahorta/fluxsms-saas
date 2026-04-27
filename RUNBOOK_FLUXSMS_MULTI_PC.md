# RUNBOOK FLUXSMS - MULTI PC (ANTI-REINCIDENCIA)

Objetivo: padronizar o procedimento para evitar repeticao do problema "PC conecta, polo ONLINE, mas chips nao aparecem".

## 1) Sintomas principais

- `health` responde OK.
- `worker/chips` retorna vazio (`chips: []`).
- Polo aparece `ONLINE`.
- Em alguns cenarios, erro de `hwid_required` ou `hwid_mismatch`.
- Em cenarios de teste manual, pode ocorrer `chips_status_check`.

---

## 2) Causa raiz (resumo tecnico)

1. **Vinculo HWID** da API key (quando preso em outro HWID).
2. **SYNC automatico do EXE** nao enviando `/partner-api/worker/sync` no PC afetado.
3. **Status de chip** divergente da constraint do banco (quando backend tenta gravar `online` e constraint aceita apenas `idle|busy|offline|quarentena`).
4. **Teste manual cria chip fake** (porta COM/numero de exemplo) e confunde diagnostico.

---

## 3) Checklist rapido padrao (sempre nessa ordem)

### 3.1 Supabase (SQL Editor)

```sql
select id, label, is_active, bound_hwid, created_at
from partner_api_keys
where key_hash = encode(
  digest('SUA_API_KEY_AQUI', 'sha256'),
  'hex'
);
```

### 3.2 PowerShell (Windows)

```powershell
$API_KEY="SUA_API_KEY_AQUI"
$HWID_REAL="BOUND_HWID_DA_QUERY"
Invoke-RestMethod -Method GET -Uri "https://fluxsms.com.br/partner-api/health" -Headers @{
  "x-api-key" = $API_KEY
  "x-flux-hwid" = $HWID_REAL
}
```

Interpretacao:
- `ok: true` => auth/hwid OK.
- `hwid_required` => chave vinculada sem header valido.
- `hwid_mismatch` => chave presa em outro HWID.

---

## 4) Procedimento de desbloqueio HWID

### 4.1 Supabase (SQL Editor)

```sql
update partner_api_keys
set bound_hwid = null
where id = 'API_KEY_ID_UUID';
```

### 4.2 Apos limpar

1. Abrir EXE no PC alvo.
2. Logar com a API key correta.
3. Confirmar novo bind:

```sql
select id, bound_hwid
from partner_api_keys
where id = 'API_KEY_ID_UUID';
```

---

## 5) Validar se o problema e backend ou EXE

### 5.1 PowerShell - leitura

```powershell
$API_KEY="SUA_API_KEY_AQUI"
$HWID_REAL="BOUND_HWID_DA_QUERY"
Invoke-RestMethod -Method GET -Uri "https://fluxsms.com.br/partner-api/worker/chips" -Headers @{
  "x-api-key" = $API_KEY
  "x-flux-hwid" = $HWID_REAL
} | ConvertTo-Json -Depth 6
```

Se `chips: []`, fazer teste de sync manual controlado:

```powershell
$API_KEY="SUA_API_KEY_AQUI"
$HWID_REAL="BOUND_HWID_DA_QUERY"
$BASE="https://fluxsms.com.br"

Invoke-RestMethod -Method POST -Uri "$BASE/partner-api/worker/sync" -Headers @{
  "x-api-key" = $API_KEY
  "x-flux-hwid" = $HWID_REAL
  "Content-Type" = "application/json"
} -Body '{"porta":"COM104","numero":"5511999999999","operadora":"HUAWEI"}'
```

Se manual funciona e automatico nao, problema esta no EXE do PC.

---

## 6) Limpeza de chip fake (quando necessario)

### Supabase (SQL Editor)

```sql
select id, porta, numero, status, registered_by_api_key_id, created_at
from chips
where registered_by_api_key_id = 'API_KEY_ID_UUID'
order by created_at desc;
```

```sql
delete from chips
where registered_by_api_key_id = 'API_KEY_ID_UUID'
  and porta in ('COM104','COM3');
```

---

## 7) Correcao global recomendada (nao depender de hotfix manual)

1. **Backend**: garantir que `routes/partnerApi.js` grave status compativel com constraint.
   - Troca recomendada: `online -> idle` no sync/heartbeat, quando aplicavel.
2. **Deploy** da correcao em producao.
3. **Padronizar monitor** com intervalo >= 15s para evitar 429.
4. **Nunca usar placeholders** em payload (`SEU_NUMERO_REAL_AQUI`), sempre numero real.
5. **Separar comandos por ambiente**:
   - SQL -> Supabase SQL Editor.
   - `$API_KEY` / `Invoke-RestMethod` -> PowerShell.

---

## 8) Operacao multi-PC sem dor (politica recomendada)

- Uma API key por estacao/PC (label claro).
- Registro interno: `PC`, `API_KEY_ID`, `bound_hwid`, `portas`.
- Ao trocar de maquina:
  1. limpar `bound_hwid`,
  2. fazer primeiro login no PC novo,
  3. validar `health` e `worker/chips`,
  4. validar sync automatico no EXE.

---

## 9) Evidencia minima para suporte tecnico

Guardar sempre:
- print do EXE,
- retorno de `health`,
- retorno de `worker/chips`,
- query de `partner_api_keys` com `bound_hwid`,
- query de `chips` por `registered_by_api_key_id`.

Com esse pacote, o diagnostico fecha em minutos.

---

## 10) Bloco curto anti-erro (PC defeituoso atual)

Use este bloco quando houver confusao no terminal. Objetivo: evitar variavel nula, evitar 429 e manter comandos curtos.

### 10.1 PowerShell - bloco 1 (validar variaveis)

```powershell
$API_KEY = 'flux_partner_4cc31cff66f934a93eccfcb3dcf1a59065b535f6a8d519e5'
$HWID_REAL = '58770917323985ba21bec0e5d1632104e0034f0eef02eca1b208a3a97c48deaf'
$BASE = 'https://fluxsms.com.br'

Write-Host "API_KEY OK? $([string]::IsNullOrWhiteSpace($API_KEY) -eq $false)"
Write-Host "HWID OK? $([string]::IsNullOrWhiteSpace($HWID_REAL) -eq $false)"
Write-Host "BASE: $BASE"
```

### 10.2 PowerShell - bloco 2 (health)

```powershell
Invoke-RestMethod -Method GET -Uri "$BASE/partner-api/health" -Headers @{
  'x-api-key' = $API_KEY
  'x-flux-hwid' = $HWID_REAL
} | ConvertTo-Json -Depth 6
```

### 10.3 PowerShell - bloco 3 (sync por porta, com pausa)

```powershell
$ports = @('COM103','COM107','COM110','COM115','COM118','COM121')

foreach ($p in $ports) {
  try {
    $body = @{ porta = $p; operadora = 'HUAWEI' } | ConvertTo-Json -Compress
    Invoke-RestMethod -Method POST -Uri "$BASE/partner-api/worker/sync" -Headers @{
      'x-api-key' = $API_KEY
      'x-flux-hwid' = $HWID_REAL
      'Content-Type' = 'application/json'
    } -Body $body | Out-Null
    Write-Host "OK -> $p"
  } catch {
    Write-Host "ERRO -> $p :: $($_.Exception.Message)"
  }
  Start-Sleep -Seconds 8
}
```

### 10.4 PowerShell - bloco 4 (leitura final)

```powershell
Invoke-RestMethod -Method GET -Uri "$BASE/partner-api/worker/chips" -Headers @{
  'x-api-key' = $API_KEY
  'x-flux-hwid' = $HWID_REAL
} | ConvertTo-Json -Depth 6
```

### 10.5 Supabase (SQL Editor) - leitura por key id do PC defeituoso

```sql
select porta, numero, status, last_ping, created_at
from chips
where registered_by_api_key_id = 'b53ac3db-f5be-40f1-8200-bca29bb41d04'
order by created_at desc;
```

### 10.6 Regra operacional critica

- Nunca colar SQL no PowerShell.
- Nunca colar PowerShell no SQL Editor.
- Sempre executar em blocos curtos (1 bloco por vez).
- Em caso de 429, aguardar 65s antes de repetir.

---

## 11) Checkpoint operacional (2026-04-26 fim de tarde)

Status consolidado desta sessão:

- Backend autenticacao OK (`/partner-api/health` com sucesso).
- Polo online OK (`/partner-api/worker/chips` retorna `ok: true`).
- Problema isolado: no PC defeituoso, chips sincronizavam com `numero = null`.
- Validacao de modem concluida: `AT+CNUM` retornou numeros reais no PC defeituoso.
- Conclusao tecnica: falha no fluxo automatico do EXE/main para propagar numero no sync.

Correcao aplicada no desktop (codigo):

- Arquivo alterado: `polo-worker-draft/src/main.js`
- Ajustes:
  - fallback de parse para linhas `+CNUM` no log;
  - envio automatico de sync quando numero e identificado;
  - retry automatico para `429` (muitas requisicoes).

Build gerada:

- Artefato principal: `public/download/FluxSMS.0.5.6-lab1.exe`
- Copia operacional para uso imediato: `C:\Users\user\Desktop\FluxSMS.0.5.6-lab1.exe`

Proximo passo operacional:

1. Instalar `FluxSMS.0.5.6-lab1.exe` no PC defeituoso.
2. Testar sem PowerShell (apenas EXE).
3. Confirmar no painel/endpoint que numeros deixam de ficar `null`.

---

## 12) Checkpoint operacional (2026-04-26 noite / cliente final)

Status consolidado:

- Validado em campo: core roda e sincroniza numeros corretamente com logica original (`Claro -> phonebook`, `TIM -> USSD`, `outros/Arqia -> CCID`).
- API validada: `/partner-api/worker/chips` retornando `online` com numeros nas portas válidas.
- Problema de UX identificado: modal de vendas mostrava histórico por `porta` mesmo quando `numero` do chip estava `null`.

Correções aplicadas:

1. Build/runtime do EXE:
   - `polo-worker-draft/scripts/prepare-core-runtime.js`
   - passou a exigir core completo (`main.py`, `state.py`, `modems/detection.py`) e usar fallback seguro em `FluxSMS_Worker_V7_1_FIX`.
2. Core start no desktop:
   - `polo-worker-draft/src/main.js`
   - preferência por `main.py` para evitar erro de `.pyc` incompatível.
3. Frontend do desktop (sem mexer no backend):
   - `polo-worker-draft/src/renderer.js`
   - consulta de histórico (`chipHistory`) só acontece quando o modem tem número válido;
   - sem número, modal informa que ativações só são exibidas após detectar número.

Artefato final para cliente:

- `C:\Users\user\Desktop\FluxSMS.0.5.6-lab1-CLIENTE-FINAL-FIX.exe`

Validação mínima pós-instalação:

1. abrir EXE;
2. atualizar monitoramento;
3. clicar em modem sem número (deve mostrar aviso, sem puxar venda);
4. clicar em modem com número (deve listar ativações normalmente).

