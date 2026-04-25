import json
import os
import re
import time
import serial.tools.list_ports
import serial

from config import (
    MAPA_HUB_ARQUIVO, CCID_NUMEROS_ARQUIVO, OPERADORA_MNCS, 
    TIMEOUT_USSD, TENTATIVAS_MAX, STATUS_FALHA, STATUS_OCUPADA, 
    STATUS_SEM_AT, STATUS_ERRO, STATUS_SEM_CHIP, STATUS_FALHAS, PREFIXO_CCID
)
import state
from modems.core import (
    enviar_comando, limpar_buffer, abrir_serial, detectar_huawei, _limpar_todos_sms, ativar_notificacoes_imediatas
)
from db.database import salvar_numero_historico
from db.cloud_sync import sync_chip_to_cloud
from web.utils_display import log  # Vamos criar isso no próximo passo ou mover pro state/utils

USSD_POR_OPERADORA = {
    "tim":   ["*846#"],
    "claro": ["*510#", "544#"],
}


def emit_fluxsms_json_ipc(porta, numero_bruto, operadora):
    """Uma linha por evento para o processo pai (Electron): prefixo fixo + JSON (stdout linha a linha)."""
    raw = str(numero_bruto or "").strip()
    digits = ""
    if "|" in raw and PREFIXO_CCID in raw:
        digits = re.sub(r"\D", "", raw.split("|")[-1])
    elif raw.startswith(PREFIXO_CCID):
        digits = re.sub(r"\D", "", raw[len(PREFIXO_CCID) :])
    else:
        digits = re.sub(r"\D", "", raw)
    obj = {
        "port": str(porta or "").strip().upper(),
        "number": digits,
        "operadora": str(operadora or ""),
    }
    print("FLUXSMS_JSON:" + json.dumps(obj, ensure_ascii=False), flush=True)

def carregar_calibracao():
    if os.path.exists(MAPA_HUB_ARQUIVO):
        try:
            with open(MAPA_HUB_ARQUIVO, 'r') as f:
                state.mapa_calibrado = json.load(f)
            if len(state.mapa_calibrado) > 1:
                print(f"  ✅ Mapa calibrado carregado ({len(state.mapa_calibrado)} posições por IMEI)")
                return
        except: pass
    print(f"  ⚠️  Sem calibração! Rode 'Calibrar Hub.py' para mapear posições")

def carregar_ccid_numeros():
    if os.path.exists(CCID_NUMEROS_ARQUIVO):
        try:
            with open(CCID_NUMEROS_ARQUIVO, 'r') as f:
                state.ccid_numeros = json.load(f)
            print(f"  ✅ Tabela CCID→Número carregada ({len(state.ccid_numeros)} chips Datora/Arquia)")
        except:
            print(f"  ⚠️  Erro ao carregar {CCID_NUMEROS_ARQUIVO}")
    else:
        print(f"  ⚠️  Sem tabela CCID→Número (ccid_numeros.json não encontrado)")

def buscar_numero_por_ccid(ccid, imsi=None):
    if ccid and ccid in state.ccid_numeros: return state.ccid_numeros[ccid]
    if ccid and ccid != "CCID_DESCONHECIDO":
        for ccid_tabela, numero in state.ccid_numeros.items():
            if ccid_tabela.endswith(ccid[-18:]) or ccid.endswith(ccid_tabela[-18:]):
                return numero
    if imsi:
        imsi_parte = imsi[3:]
        for ccid_tabela, numero in state.ccid_numeros.items():
            if imsi_parte in ccid_tabela: return numero
    return None

def atribuir_grid(porta, imei):
    if imei in state.mapa_calibrado:
        info = state.mapa_calibrado[imei]
        state.mapa_usb[porta] = {"imei": imei, "grid": info["grid"], "slot": info["slot"]}
    else:
        state.mapa_usb[porta] = {"imei": imei, "grid": "??", "slot": 99}

def ler_imei(ser):
    limpar_buffer(ser)
    res = enviar_comando(ser, "AT+GSN", timeout=1)
    imei = re.sub(r'[^0-9]', '', res)
    return imei[:15] if len(imei) >= 14 else "DESCONHECIDO"

def ler_ccid(ser):
    for cmd in ("AT^ICCID", "AT+CCID", "AT+ICCID", "AT+QCCID"):
        limpar_buffer(ser)
        res = enviar_comando(ser, cmd, timeout=1)
        match = re.search(r'(\d{18,22})', res)
        if match: return match.group(1)
    limpar_buffer(ser)
    res = enviar_comando(ser, "AT+CRSM=176,12258,0,0,10", timeout=2)
    match = re.search(r'\+CRSM:\s*\d+,\d+,"([0-9A-Fa-f]+)"', res)
    if match:
        hex_raw = match.group(1)
        ccid = ""
        for i in range(0, len(hex_raw), 2):
            byte = hex_raw[i:i+2]
            ccid += byte[1] + byte[0]
        ccid = ccid.replace("F", "").replace("f", "")
        if len(ccid) >= 18: return ccid
    return "CCID_DESCONHECIDO"

def detectar_operadora_rede(ser):
    limpar_buffer(ser)
    enviar_comando(ser, "AT+COPS=3,0", timeout=1)
    limpar_buffer(ser)
    res = enviar_comando(ser, "AT+COPS?", timeout=2)
    match = re.search(r'\+COPS:\s*\d+,\d+,"([^"]+)"', res)
    if match: return match.group(1).strip()
    match = re.search(r'\+COPS:\s*\d+,\d+,(\d+)', res)
    if match: return match.group(1).strip()
    return None

def detectar_provedor_sim(ser):
    limpar_buffer(ser)
    res = enviar_comando(ser, "AT+CSPN?", timeout=2)
    match = re.search(r'\+CSPN:\s*"([^"]+)"', res)
    if match: return match.group(1).strip()
    return None

def ler_imsi(ser):
    limpar_buffer(ser)
    res = enviar_comando(ser, "AT+CIMI", timeout=1)
    match = re.search(r'(\d{15})', res)
    if match: return match.group(1)
    return None

def identificar_chip(ser):
    spn = detectar_provedor_sim(ser)
    imsi = ler_imsi(ser)
    mnc5 = imsi[:5] if imsi else None
    rede = detectar_operadora_rede(ser)

    nome = spn or rede or "Desconhecida"
    operadora_id = None
    
    # Identifica operadora pelo MNC no Brasil (MMC=724)
    if imsi and len(imsi) >= 5 and imsi.startswith("724"):
        mnc2 = imsi[3:5]
        nome_op = OPERADORA_MNCS.get(mnc2)
        if nome_op:
            operadora_id = nome_op.lower()

    # Fallback por nome da rede
    if not operadora_id and rede:
        rede_lower = rede.lower()
        if "claro" in rede_lower:
            operadora_id = "claro"
        elif "tim" in rede_lower:
            operadora_id = "tim"
        elif "vivo" in rede_lower:
            operadora_id = "vivo"

    # Se a operadora não tem USSD configurado e não for a exceção da Claro,
    # reseta para None para cair na busca por CCID (Datora, Arqia, Vivo etc)
    if operadora_id and operadora_id != "claro" and operadora_id not in USSD_POR_OPERADORA:
        operadora_id = None

    return nome, spn, rede, imsi, operadora_id

def parsear_ccid(valor):
    sem_prefixo = str(valor)[len(PREFIXO_CCID):]
    if "|" in sem_prefixo:
        ccid, numero = sem_prefixo.split("|", 1)
        return ccid, numero
    return sem_prefixo, None

def filtrar_portas_at():
    pc_ui, app, outras = [], [], []
    for p in serial.tools.list_ports.comports():
        if p.device == "COM1": continue
        desc = p.description or ""
        if "Application Interface" in desc: app.append(p.device)
        elif "PC UI Interface" in desc: pc_ui.append(p.device)
        else: outras.append(p.device)

    if pc_ui:
        ignoradas = len(app) + len(outras)
        print(f"  📱 Huawei detectado: {len(pc_ui)} modems")
        print(f"  ℹ  {ignoradas} portas duplicadas ignoradas")
        portas = pc_ui
    else:
        portas = outras
    return sorted(portas, key=lambda x: int(re.sub(r'\D', '', x)))

def checar_sim(ser):
    res = enviar_comando(ser, "AT+CPIN?", timeout=1)
    return "READY" in res.upper()

def aguardar_registro(ser, porta):
    """Garante que o modem tente registrar na rede, incluindo roaming."""
    log(porta, "Forçando busca de rede (Auto/Roaming)...", "📡")
    enviar_comando(ser, "AT+CREG=2", timeout=0.5) # Habilita log detalhado de registro
    enviar_comando(ser, "AT+COPS=0", timeout=1)   # Força busca automática (essencial para Roaming)
    
    for i in range(1, 16): # Aumentado para 15 tentativas (30 seg) pois Roaming demora mais
        res = enviar_comando(ser, "AT+CREG?", timeout=1)
        # Status 1 = Home Network, Status 5 = Roaming
        if ",1" in res or ",5" in res:
            tipo = "Roaming" if ",5" in res else "Home"
            log(porta, f"Registrado ({tipo})", "📶")
            return True
        if i % 3 == 0:
            log(porta, f"Buscando sinal ({i}/15)...", "⏳")
        time.sleep(2)
    return False

def decodificar_ussd_ucs2(resposta):
    match = re.search(r'\+CUSD:\s*\d+,"([^"]+)"(?:,(\d+))?', resposta)
    if not match: return resposta
    conteudo = match.group(1)
    dcs = match.group(2)
    is_ucs2 = False
    if dcs and int(dcs) in (72, 68, 24): is_ucs2 = True
    elif re.match(r'^[0-9A-Fa-f]+$', conteudo) and len(conteudo) >= 20 and len(conteudo) % 4 == 0: is_ucs2 = True
    if is_ucs2:
        try: return bytes.fromhex(conteudo).decode('utf-16-be')
        except: pass
    return resposta

def extrair_numero(resposta):
    limpo = re.sub(r'\^[A-Z]+:.*', '', resposta)
    limpo_ucs2 = decodificar_ussd_ucs2(limpo)
    if limpo_ucs2 != limpo: limpo = limpo_ucs2
    sequencias = re.findall(r'(\d{10,13})', limpo)
    if not sequencias: return None
    candidatos = []
    for s in sequencias:
        temp = s
        if temp.startswith("55") and len(temp) >= 12: temp = temp[2:]
        if 10 <= len(temp) <= 11: candidatos.append(temp)
    return candidatos[-1] if candidatos else None

def _extrair_numero_phonebook(texto):
    limpo = re.sub(r'\^[A-Z]+:\s*\d+\s*', '', texto)
    limpo = re.sub(r'[\r\n]+', ' ', limpo)
    nums_aspas = re.findall(r'"[+]?(\d{10,15})"', limpo)
    if not nums_aspas: nums_aspas = re.findall(r'\+?(\d{10,15})', limpo)
    for num in nums_aspas:
        temp = num
        if temp.startswith("55") and len(temp) >= 12: temp = temp[2:]
        if temp.startswith("0") and len(temp) == 12: temp = temp[1:]
        if 10 <= len(temp) <= 11: return temp
    return None

def buscar_numero_phone_book(ser):
    melhor = None
    for storage in ("ON", "EN", "SM", "MC", "LD"):
        limpar_buffer(ser)
        res_pb = enviar_comando(ser, f'AT+CPBS="{storage}"', timeout=0.5)
        if "OK" in res_pb:
            limpar_buffer(ser)
            res = enviar_comando(ser, "AT+CPBR=1,20", timeout=1.2) # Busca rápida
            num = _extrair_numero_phonebook(res)
            if num and len(num) == 11: return num
            if num and not melhor: melhor = num

    limpar_buffer(ser)
    enviar_comando(ser, 'AT+CPBS="ON"', timeout=1)
    limpar_buffer(ser)
    res = enviar_comando(ser, "AT^CPBR=1,10", timeout=2)
    num = _extrair_numero_phonebook(res)
    if num and len(num) == 11: return num
    if num and not melhor: melhor = num

    limpar_buffer(ser)
    res_pb = enviar_comando(ser, 'AT+CPBS="SM"', timeout=1)
    if "OK" in res_pb:
        limpar_buffer(ser)
        res = enviar_comando(ser, "AT+CPBR=1,10", timeout=2)
        num = _extrair_numero_phonebook(res)
        if num and len(num) == 11: return num
        if num and not melhor: melhor = num

    limpar_buffer(ser)
    res = enviar_comando(ser, "AT+CNUM", timeout=2)
    num = _extrair_numero_phonebook(res)
    if num and len(num) == 11: return num
    if num and not melhor: melhor = num

    limpar_buffer(ser)
    res = enviar_comando(ser, "AT^CNUM", timeout=2)
    num = _extrair_numero_phonebook(res)
    if num and len(num) == 11: return num
    if num and not melhor: melhor = num

    return melhor

def enviar_ussd_huawei(ser, codigo_ussd="*846#"):
    limpar_buffer(ser)
    enviar_comando(ser, "AT", timeout=0.5)
    limpar_buffer(ser)
    enviar_comando(ser, "AT+CUSD=2", timeout=1)
    limpar_buffer(ser)
    enviar_comando(ser, "AT^USSDMODE=0", timeout=1)
    limpar_buffer(ser)
    enviar_comando(ser, 'AT+CSCS="GSM"', timeout=0.5)
    limpar_buffer(ser)
    ser.write((f'AT+CUSD=1,"{codigo_ussd}"\r\n').encode())
    resposta_total = ""
    inicio = time.time()
    while (time.time() - inicio) < TIMEOUT_USSD:
        time.sleep(1)
        try:
            chunk = ser.read_all().decode(errors='ignore')
            resposta_total += chunk
            numero = extrair_numero(resposta_total)
            if numero: return resposta_total, numero
            if "+CME ERROR" in chunk or "+CUSD: 2" in chunk: return resposta_total, None
        except: pass
    return resposta_total, extrair_numero(resposta_total)

def enviar_ussd_padrao(ser, codigo_ussd="*846#"):
    limpar_buffer(ser)
    enviar_comando(ser, "AT")
    enviar_comando(ser, 'AT+CSCS="GSM"')
    enviar_comando(ser, "AT+CUSD=2", timeout=1)
    res = enviar_comando(ser, f'AT+CUSD=1,"{codigo_ussd}"', timeout=TIMEOUT_USSD)
    num = extrair_numero(res)
    if not num:
        limpar_buffer(ser)
        res = enviar_comando(ser, f'AT+CUSD=1,"{codigo_ussd}",15', timeout=TIMEOUT_USSD)
        num = extrair_numero(res)
    return res, num

def tarefa_identificar_porta(porta):
    from config import MEMORIAS_HUAWEI, MEMORIAS_PADRAO
    with state.semaforo:
        numero_encontrado = STATUS_FALHA
        operadora_id = None
        nome = "Desconhecida"
        try:
            log(porta, "Conectando...", "🔌")
            ser = abrir_serial(porta)
            if not ser:
                log(porta, STATUS_SEM_AT, "❌")
                with state.lock: state.resultados[porta] = STATUS_SEM_AT
                with state.contador_lock: state.portas_concluidas += 1
                return

            log(porta, "AT OK", "✅")
            imei = ler_imei(ser)
            atribuir_grid(porta, imei)

            if not checar_sim(ser):
                log(porta, "Sem chip detectado", "🚫")
                with state.lock: state.resultados[porta] = STATUS_SEM_CHIP
                with state.contador_lock: state.portas_concluidas += 1
                return

            is_huawei = detectar_huawei(ser)
            if is_huawei: log(porta, "Huawei detectado", "📱")
            with ser:
                log(porta, "Limpando lixo do chip...", "🧹")
                enviar_comando(ser, "AT+CMGF=1")
                mems = MEMORIAS_HUAWEI if is_huawei else MEMORIAS_PADRAO
                _limpar_todos_sms(ser, mems)
                
            with ser:
                log(porta, "Verificando sinal/rede...", "📶")
                if not aguardar_registro(ser, porta): log(porta, "Sem sinal ou rede negada", "⚠️")
                
                log(porta, "Otimizando recepção de SMS (Alta Velocidade)...", "🚀")
                ativar_notificacoes_imediatas(ser)

                nome, spn, rede, imsi, operadora_id = identificar_chip(ser)
                
                # Antecipa leitura do CCID para corrigir MVNOs (Arqia) que usam a rede da TIM
                ccid = ler_ccid(ser)
                is_arqia = False
                if ccid.startswith("895518") or ccid.startswith("895552") or buscar_numero_por_ccid(ccid):
                    is_arqia = True

                if is_arqia:
                    operadora_id = None
                    nome = "Arqia/Datora"

                log(porta, f"SPN: {spn or '?'} | Rede: {rede or '?'} | IMSI: {imsi or '?'} | Op: {operadora_id or '?'}", "📡")

                if not operadora_id:
                    log(porta, f"Chip {nome} — USSD não suportado", "🔶")
                    log(porta, f"CCID: {ccid}", "🆔")
                    num_lookup = buscar_numero_por_ccid(ccid)
                    if num_lookup:
                        log(porta, f"Número (via tabela): {num_lookup}", "✅")
                        numero_encontrado = PREFIXO_CCID + ccid + "|" + num_lookup
                    else:
                        log(porta, f"CCID não encontrado na tabela", "⚠️")
                        numero_encontrado = PREFIXO_CCID + ccid
                elif operadora_id == "claro":
                    log(porta, f"Operadora CLARO — USSD não suportado, usando phone book", "📞")
                    num_pb = buscar_numero_phone_book(ser)
                    if num_pb:
                        numero_encontrado = num_pb
                        log(porta, f"Número (phone book): {num_pb}", "✅")
                    else:
                        ccid = ler_ccid(ser)
                        log(porta, f"CCID: {ccid}", "🆔")
                        numero_encontrado = PREFIXO_CCID + ccid
                        log(porta, f"Phone book sem número, usando CCID como identificador", "⚠️")
                else:
                    codigos_ussd = USSD_POR_OPERADORA[operadora_id]
                    log(porta, f"Operadora {operadora_id.upper()} — USSD: {', '.join(codigos_ussd)}", "📞")
                    tentativas_por_codigo = max(2, TENTATIVAS_MAX // len(codigos_ussd))
                    for codigo_ussd in codigos_ussd:
                        if numero_encontrado != STATUS_FALHA: break
                        for i in range(1, tentativas_por_codigo + 1):
                            log(porta, f"USSD {codigo_ussd} tentativa {i}/{tentativas_por_codigo}...", "📡")
                            if is_huawei: res, numero = enviar_ussd_huawei(ser, codigo_ussd)
                            else: res, numero = enviar_ussd_padrao(ser, codigo_ussd)
                            if numero:
                                numero_encontrado = numero
                                log(porta, f"Número USSD: {numero}", "✅")
                                break
                            res_limpo = re.sub(r'\^RSSI:\s*\d+\s*', '', res).strip()
                            res_limpo = res_limpo[:50].replace('\n', ' ').replace('\r', '')
                            if "+CME ERROR" in res:
                                erro = re.search(r'\+CME ERROR:\s*(\d+)', res)
                                log(porta, f"Tentativa {i}: CME ERROR {erro.group(1) if erro else '?'}", "⚠️")
                            elif "+CUSD: 2" in res: log(porta, f"Tentativa {i}: Rede cancelou USSD", "⚠️")
                            elif res_limpo: log(porta, f"Tentativa {i}: {res_limpo}", "⚠️")
                            else: log(porta, f"Tentativa {i}: sem resposta", "⚠️")
                            time.sleep(5)
                    if numero_encontrado == STATUS_FALHA:
                        log(porta, "USSD falhou — tentando phone book do SIM...", "📖")
                        num_pb = buscar_numero_phone_book(ser)
                        if num_pb:
                            numero_encontrado = num_pb
                            log(porta, f"Número (phone book): {num_pb}", "✅")
                        else:
                            log(porta, "Esgotou tentativas sem número", "❌")

                # Removido AT+CFUN=0 para manter o chip 'vivo' e recebendo SMS após a identificação
                pass

        except serial.SerialException as e:
            log(porta, f"Erro serial: {str(e)[:40]}", "❌")
            numero_encontrado = STATUS_OCUPADA
        except Exception as e:
            log(porta, f"Erro: {str(e)[:40]}", "❌")
            numero_encontrado = STATUS_ERRO

        with state.lock:
            state.resultados[porta] = numero_encontrado
        
        if numero_encontrado not in STATUS_FALHAS:
            n_salvar = numero_encontrado.split("|")[1] if "|" in str(numero_encontrado) else numero_encontrado
            salvar_numero_historico(n_salvar)
            # Sincroniza com o site na nuvem
            sync_chip_to_cloud(porta, n_salvar, operadora_id or nome)
            emit_fluxsms_json_ipc(porta, n_salvar, operadora_id or nome)

        with state.contador_lock:
            state.portas_concluidas += 1
            pct = int((state.portas_concluidas / state.total_portas) * 100) if state.total_portas > 0 else 0
            barra = "█" * (pct // 5) + "░" * (20 - pct // 5)
            with state.lock:
                print(f"\n  ── Progresso: {barra} {pct}% ({state.portas_concluidas}/{state.total_portas}) ──\n")
