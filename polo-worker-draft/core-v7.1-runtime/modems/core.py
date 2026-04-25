import serial
import time
import re
from config import BAUD_RATE, BAUD_RATE_FALLBACK, RETRY_PORTA, RETRY_PORTA_DELAY, MEMORIAS_HUAWEI, MEMORIAS_PADRAO

def enviar_comando(ser, comando, timeout=1.0):
    """Envia comando AT e retorna resposta lendo o buffer ativamente (sem sleeps fixos)."""
    try:
        ser.write((comando + '\r\n').encode())
        resposta = ""
        inicio = time.time()
        while (time.time() - inicio) < timeout:
            if ser.in_waiting:
                chunk = ser.read(ser.in_waiting).decode(errors='ignore')
                resposta += chunk
                if "OK" in resposta or "ERROR" in resposta:
                    break
            time.sleep(0.05) # Pequeno fôlego para a CPU
        return resposta
    except Exception:
        return ""

def limpar_buffer(ser):
    """Limpa buffers serial de forma agressiva."""
    try:
        ser.reset_input_buffer()
        ser.reset_output_buffer()
        time.sleep(1.0)
        if ser.in_waiting:
            ser.read_all()
        time.sleep(0.2)
        if ser.in_waiting:
            ser.read_all()
    except:
        pass

def testar_conexao_at(ser):
    """Testa se a porta responde a comandos AT."""
    limpar_buffer(ser)
    res = enviar_comando(ser, "AT", timeout=1)
    return "OK" in res

def abrir_serial(porta, retries=RETRY_PORTA):
    """Abre conexão serial com retry e fallback de baud rate."""
    from state import lock
    
    ser = None
    for tentativa in range(1, retries + 1):
        try:
            ser = serial.Serial(porta, BAUD_RATE, timeout=1, write_timeout=1)
            break
        except serial.SerialException:
            if tentativa < retries:
                time.sleep(RETRY_PORTA_DELAY)
            else:
                raise

    if not testar_conexao_at(ser):
        ser.close()
        ser = serial.Serial(porta, BAUD_RATE_FALLBACK, timeout=1, write_timeout=1)
        if not testar_conexao_at(ser):
            ser.close()
            return None

    return ser

def abrir_serial_simples(porta):
    """Abre serial sem log (para monitor/watch)."""
    try:
        ser = serial.Serial(porta, BAUD_RATE, timeout=1)
        if not testar_conexao_at(ser):
            ser.close()
            ser = serial.Serial(porta, BAUD_RATE_FALLBACK, timeout=1)
        return ser
    except:
        pass
        
    try:
        ser = serial.Serial(porta, BAUD_RATE_FALLBACK, timeout=1)
        return ser
    except:
        return None

def detectar_huawei(ser):
    """Detecta se o modem é Huawei pelo fabricante."""
    res = enviar_comando(ser, "AT+CGMI", timeout=1)
    return "huawei" in res.lower()

def ativar_notificacoes_imediatas(ser):
    """Configura o modem para avisar imediatamente (+CMTI ou texto) quando chegar SMS."""
    # Configurações de Compatibilidade (Essencial para Huawei/Arqia)
    enviar_comando(ser, "AT+CMGF=1", timeout=0.5)
    enviar_comando(ser, 'AT+CSCS="GSM"', timeout=0.5)
    enviar_comando(ser, 'AT+CPMS="MT","MT","MT"', timeout=0.8) 
    enviar_comando(ser, "AT+CSMP=17,167,0,0", timeout=0.8)
    
    # Ativa Notificações em Tempo Real (Event-Driven)
    # CNMI=2,2... faz o modem enviar o texto do SMS direto para a serial (Ultra Rápido)
    enviar_comando(ser, "AT+CNMI=2,2,0,0,0", timeout=1.0)
    enviar_comando(ser, "AT^CURC=0", timeout=0.5) # Desativa ruído de sinal de rede

def _limpar_urcs(texto):
    texto = re.sub(r'\^(RSSI|HCSQ|MODE|BOOT|DSFLOWRPT|SIMST|SRVST|CEND):[^\r\n]*', '', texto)
    texto = re.sub(r'\+(CMTI|CREG|CGREG):[^\r\n]*', '', texto)
    return texto

def decodificar_texto_gsm(texto):
    if not texto: return ""
    linhas = texto.strip().split('\n')
    resultados = []
    for linha in linhas:
        linha_limpa = linha.strip()
        if not linha_limpa: continue
        hex_candidato = re.sub(r'\s+', '', linha_limpa)
        if (re.match(r'^[0-9A-Fa-f]+$', hex_candidato) and len(hex_candidato) >= 8 and len(hex_candidato) % 4 == 0):
            try:
                decodificado = bytes.fromhex(hex_candidato).decode('utf-16-be')
                if any(c.isalpha() or c.isdigit() for c in decodificado):
                    resultados.append(decodificado)
                    continue
            except:
                pass
        resultados.append(linha_limpa)
    return ' '.join(resultados) if resultados else texto

def _decodificar_gsm7(data, num_chars):
    GSM7 = ('@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\x1bÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà')
    resultado = []
    bits = 0
    pos_byte = 0
    for _ in range(num_chars):
        if pos_byte >= len(data): break
        char_code = (data[pos_byte] >> bits) & 0x7F
        remaining = 8 - bits
        if remaining < 7 and pos_byte + 1 < len(data):
            char_code |= (data[pos_byte + 1] << remaining) & 0x7F
        bits += 7
        while bits >= 8:
            bits -= 8
            pos_byte += 1
        if char_code < len(GSM7): resultado.append(GSM7[char_code])
        else: resultado.append(chr(char_code))
    return ''.join(resultado)

def decodificar_pdu_basico(pdu_hex):
    try:
        pdu_hex = re.sub(r'[^0-9A-Fa-f]', '', pdu_hex)
        if len(pdu_hex) < 20: return None
        pdu = bytes.fromhex(pdu_hex)
        pos = 0
        smsc_len = pdu[pos]
        pos += 1 + smsc_len
        first_octet = pdu[pos]
        has_udh = bool(first_octet & 0x40)
        pos += 1
        sender_digits = pdu[pos]
        pos += 1
        pos += 1
        sender_bytes = (sender_digits + 1) // 2
        pos += sender_bytes
        pos += 1
        dcs = pdu[pos]
        pos += 1
        pos += 7
        udl = pdu[pos]
        pos += 1
        ud = pdu[pos:]
        udh_len = 0
        if has_udh and len(ud) > 0:
            udh_len = ud[0] + 1
        
        if dcs == 0x08:
            texto_bytes = ud[udh_len:]
            try:
                texto = texto_bytes.decode('utf-16-be', errors='replace')
                return texto.strip('\x00')
            except:
                return None
        elif (dcs & 0x0C) == 0x00 or dcs == 0:
            texto = _decodificar_gsm7(ud, udl)
            if has_udh:
                udh_bits = udh_len * 8
                padding = (7 - (udh_bits % 7)) % 7
                septets_skip = (udh_bits + padding) // 7
                return texto[septets_skip:].strip('\x00')
            return texto.strip('\x00')
        return None
    except Exception:
        return None

def ler_sms_pdu_mode(ser, memorias=None):
    if memorias is None: memorias = ["MT"]
    todas_msgs = []
    textos_vistos = set()
    limpar_buffer(ser)
    enviar_comando(ser, "AT+CMGF=0", timeout=0.5)
    for mem in memorias:
        limpar_buffer(ser)
        res_cpms = enviar_comando(ser, f'AT+CPMS="{mem}","{mem}","{mem}"', timeout=1)
        if "ERROR" in res_cpms: continue
        limpar_buffer(ser)
        resposta = enviar_comando(ser, "AT+CMGL=4", timeout=5)
        resposta = _limpar_urcs(resposta)
        blocos = re.split(r'\+CMGL:\s*(\d+)', resposta)
        i = 1
        while i < len(blocos) - 1:
            idx = blocos[i]
            resto = blocos[i + 1]
            linhas = [l.strip() for l in resto.strip().split('\n') if l.strip()]
            if len(linhas) >= 2:
                meta = linhas[0]
                pdu_hex = linhas[1].replace("OK", "").replace("ERROR", "").strip()
                texto = decodificar_pdu_basico(pdu_hex)
                if texto:
                    texto_hash = texto[:80]
                    if texto_hash not in textos_vistos:
                        textos_vistos.add(texto_hash)
                        todas_msgs.append({"index": idx, "meta": meta, "texto": texto, "sms_id": f"PDU:{mem}:{idx}", "storage": mem})
            i += 2
    enviar_comando(ser, "AT+CMGF=1", timeout=0.5)
    return todas_msgs

def extrair_sms_individuais(resposta_cmgl):
    mensagens = []
    blocos = re.split(r'(\+CMGL:\s*\d+)', resposta_cmgl)
    i = 1
    while i < len(blocos) - 1:
        header = blocos[i]
        corpo = blocos[i + 1]
        idx_match = re.search(r'(\d+)', header)
        idx = idx_match.group(1) if idx_match else "?"
        linhas = corpo.strip().split('\n')
        meta = linhas[0].strip() if linhas else ""
        conteudo_linhas = []
        for linha in linhas[1:]:
            l = linha.strip()
            if l and l != "OK" and l != "ERROR":
                conteudo_linhas.append(l)
        texto = decodificar_texto_gsm('\n'.join(conteudo_linhas))
        mensagens.append({"index": idx, "meta": meta, "texto": texto})
        i += 2
    return mensagens

def ler_sms_completo(ser, is_huawei=False, pdu_primario=False):
    memorias = MEMORIAS_HUAWEI if is_huawei else MEMORIAS_PADRAO
    todas_msgs = []
    textos_vistos = set()

    # Para Huawei ou se solicitado, tenta PDU primeiro (Modo Digital Bruto)
    if is_huawei or pdu_primario:
        try:
            msgs_pdu = ler_sms_pdu_mode(ser, memorias)
            for sms in msgs_pdu:
                texto_hash = sms["texto"][:80] if sms["texto"] else ""
                if texto_hash and texto_hash not in textos_vistos:
                    textos_vistos.add(texto_hash)
                    todas_msgs.append(sms)
        except: pass

    # Tenta Modo Texto como redundância ou se não for Huawei
    try:
        enviar_comando(ser, "AT+CMGF=1", timeout=0.5)
        enviar_comando(ser, 'AT+CSCS="GSM"', timeout=0.5)
        for mem in memorias:
            try:
                limpar_buffer(ser)
                res_cpms = enviar_comando(ser, f'AT+CPMS="{mem}","{mem}","{mem}"', timeout=0.8)
                if "ERROR" in res_cpms: continue
                limpar_buffer(ser)
                resposta = enviar_comando(ser, 'AT+CMGL="ALL"', timeout=4)
                resposta = _limpar_urcs(resposta)
                for sms in extrair_sms_individuais(resposta):
                    sms["sms_id"] = f"TXT:{mem}:{sms['index']}"
                    sms["storage"] = mem
                    texto_hash = sms["texto"][:80] if sms["texto"] else ""
                    if texto_hash and texto_hash not in textos_vistos:
                        textos_vistos.add(texto_hash)
                        todas_msgs.append(sms)
            except: continue
    except: pass

    return todas_msgs

def _limpar_todos_sms(ser, memorias, sms_lidos=None):
    if sms_lidos:
        for sms in sms_lidos:
            idx = sms.get("index")
            if idx and str(idx).isdigit():
                enviar_comando(ser, f"AT+CMGD={idx}", timeout=0.3)
                
    for mem in memorias:
        limpar_buffer(ser)
        res = enviar_comando(ser, f'AT+CPMS="{mem}","{mem}","{mem}"', timeout=1)
        if "ERROR" in res: continue
        enviar_comando(ser, "AT+CMGD=1,4", timeout=3)
