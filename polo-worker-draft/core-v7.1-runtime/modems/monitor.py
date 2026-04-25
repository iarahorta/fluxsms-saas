import re
import time
import threading
import state
from config import SERVICOS, SERVICOS_ORDEM, MEMORIAS_HUAWEI, MEMORIAS_PADRAO, PREFIXO_CCID
from modems.core import (
    abrir_serial_simples, enviar_comando, detectar_huawei,
    ler_sms_completo, _limpar_todos_sms, ativar_notificacoes_imediatas
)
from modems.detection import parsear_ccid
from db.database import salvar_sms_historico
from db.cloud_sync import sync_sms_to_cloud

# Pré-compilar regexes para performance milimétrica
for srv_id in SERVICOS:
    SERVICOS[srv_id]["compiled_regex"] = re.compile(SERVICOS[srv_id]["codigo_regex"], re.IGNORECASE)

def detectar_servico(texto_sms):
    texto_lower = texto_sms.lower()
    for srv_id in SERVICOS_ORDEM:
        srv = SERVICOS[srv_id]
        if any(kw in texto_lower for kw in srv["keywords"]):
            match = srv["compiled_regex"].search(texto_sms)
            if match:
                try: codigo = match.group(1) + match.group(2)
                except IndexError: codigo = match.group(1)
                return srv_id, srv["name" if "name" in srv else "nome"], codigo
    return None, None, None

def processar_sms_instantaneo(texto, numero, porta, grid, ids_processados):
    """Processa um texto de SMS recebido via URC ou Polling de forma ultra-rápida."""
    texto = texto.strip()
    if not texto: return
    
    msg_id = f"{numero}:{texto}"
    if msg_id in ids_processados: return
    ids_processados.add(msg_id)

    # Log Bruto Inteligente
    print(f"\n  ⚡ [INSTANT SMS] {porta} -> {numero}")
    digits_match = re.search(r'\d{4,8}', texto)
    if digits_match: print(f"  🔑 CANDIDATO: {digits_match.group(0)}")
    
    srv_id, servico, codigo = detectar_servico(texto)
    if not srv_id: srv_id, servico, codigo = None, "Desconhecido", (digits_match.group(0) if digits_match else texto[:15])

    # Fila local para exibição no terminal
    item = {"servico": servico, "codigo": codigo, "numero": numero, "porta": porta, "grid": grid, "timestamp": time.strftime('%H:%M:%S')}
    with state.fila_lock: state.fila_codigos.append(item)
    
    # Sincronização Imediata
    print(f"  🚀 [SYNC] {servico}: {codigo}")
    sync_sms_to_cloud(numero, (codigo if srv_id else texto), srv_id)
    
    try: salvar_sms_historico(numero, porta, servico, codigo, texto)
    except: pass

def monitorar_sms(porta, numero):
    grid = state.mapa_usb.get(porta, {}).get("grid", "??")
    print(f"\n" + "═"*60)
    print(f" 🔍 MONITORAMENTO BRUTO: {porta} [{grid}]")
    print(f" 📂 MOSTRANDO TODA A CAIXA DE ENTRADA (TODAS AS MEMÓRIAS)")
    print(f" (Pressione Ctrl+C para VOLTAR ao menu principal)")
    print("═"*60 + "\n")

    try:
        ser = abrir_serial_simples(porta)
        if not ser: return
        with ser:
            enviar_comando(ser, "AT+CMGF=1")
            is_huawei = detectar_huawei(ser)
            memorias = MEMORIAS_HUAWEI if is_huawei else MEMORIAS_PADRAO
            _limpar_todos_sms(ser, memorias)
            ativar_notificacoes_imediatas(ser)

            ultima_qtd = -1
            while True:
                lista = ler_sms_completo(ser, is_huawei)
                qtd_atual = len(lista)
                if qtd_atual != ultima_qtd:
                    if qtd_atual > 0:
                        print(f"\n 📬 MENSAGENS ENCONTRADAS ({qtd_atual}) - {time.strftime('%H:%M:%S')}")
                        for m in lista:
                            texto = m.get('texto', '').strip()
                            srv_id, servico, codigo = detectar_servico(texto)
                            if not srv_id or not codigo:
                                srv_id = None
                                servico = "Desconhecido"
                                codigo = texto[:15] + "..."
                            
                            item = {"servico": servico, "codigo": codigo, "numero": numero, "porta": porta, "grid": grid, "timestamp": time.strftime('%H:%M:%S')}
                            with state.fila_lock:
                                if not any(x["numero"] == numero and x["codigo"] == codigo for x in state.fila_codigos):
                                    state.fila_codigos.append(item)
                            
                            try: salvar_sms_historico(numero, porta, servico, codigo, texto)
                            except: pass
                            
                            # Sincroniza SMS com a nuvem (Ativação) - Envia apenas o código se reconhecido E vinculado ao serviço
                            sync_sms_to_cloud(numero, (codigo if srv_id else texto), srv_id)
                            print(f" [#] ID: {m.get('index')} | {servico}: {codigo}")
                    ultima_qtd = qtd_atual
                time.sleep(2.0)
    except KeyboardInterrupt: pass

def thread_monitor_individual(porta, numero, stop_evt):
    grid = state.mapa_usb.get(porta, {}).get("grid", "??")
    ids_processados = set()
    with state.lock: print(f"\n  [WEB REQUEST] 📥 Iniciando monitoramento individual: {porta} [{grid}] ({numero})")
    try:
        ser = abrir_serial_simples(porta)
        if not ser:
            with state.lock: print(f"  ❌ [WEB REQUEST] Falha ao abrir porta {porta} (Ocupada ou erro)")
            return
        with ser:
            from modems.detection import aguardar_registro
            with state.lock: print(f"  [INFO] Verificando sinal da torre em {porta}...")
            aguardar_registro(ser, porta)
            
            is_huawei = detectar_huawei(ser)
            memorias = MEMORIAS_HUAWEI if is_huawei else MEMORIAS_PADRAO
            enviar_comando(ser, "AT+CMGF=1")
            _limpar_todos_sms(ser, memorias)
            ativar_notificacoes_imediatas(ser)
            
            with state.lock: print(f"  [OK] Monitoramento ATIVO na porta {porta}. Aguardando SMS...")
            while not stop_evt.is_set():
                todas_sms = ler_sms_completo(ser, is_huawei, pdu_primario=is_huawei)
                for sms in todas_sms:
                    texto = sms.get("texto", "").strip()
                    # ============================================
                    # [DEBUG RAW] LOG BRUTO - MOSTRA TUDO QUE CHEGA
                    with state.lock:
                        print(f"\n  {'='*55}")
                        print(f"  🚨 [SMS BRUTO] Numero: {numero} | Porta: {porta}")
                        print(f"  📩 TEXTO COMPLETO: {repr(texto)}")
                        if any(c.isdigit() for c in texto):
                            digits = ''.join(c for c in texto if c.isdigit())
                            if len(digits) >= 5:
                                print(f"  🔑 DÍGITOS DETECTADOS: {digits}  ← POSSÍVEL CÓDIGO")
                        print(f"  {'='*55}\n")
                    # ============================================
                    
                    # Identificador único para evitar processar o mesmo SMS na mesma sessão repetidamente
                    msg_id = f"{numero}:{texto}"
                    if not texto or msg_id in ids_processados: continue
                    
                    srv_id, servico, codigo = detectar_servico(texto)
                    if not srv_id or not codigo: srv_id, servico, codigo = None, "Desconhecido", texto[:15]+"..."
                    
                    item = {"servico": servico, "codigo": codigo, "numero": numero, "porta": porta, "grid": grid, "timestamp": time.strftime('%H:%M:%S')}
                    ids_processados.add(msg_id)
                    
                    with state.fila_lock:
                        if not any(x["numero"] == numero and x["codigo"] == codigo for x in state.fila_codigos):
                            state.fila_codigos.append(item)
                            
                    try: salvar_sms_historico(numero, porta, servico, codigo, texto)
                    except: pass
                    
                    # Sincroniza SMS com a nuvem (Ativação) - Envia apenas o código se reconhecido E vinculado ao serviço
                    if srv_id:
                        with state.lock: print(f"  ✅ [MATCH] Serviço '{servico}' reconhecido. Enviando código '{codigo}' para a nuvem...")
                    else:
                        with state.lock: print(f"  ⚠️  [SEM MATCH] SMS não reconhecido como serviço válido. NÃO enviado para nuvem (proteção de privacidade).")
                    sync_sms_to_cloud(numero, (codigo if srv_id else texto), srv_id)
                _limpar_todos_sms(ser, memorias, todas_sms)
                time.sleep(0.5)
    except Exception as e:
        with state.lock: print(f"  ❌ [WEB REQUEST] Erro monitorando {porta}: {e}")
    finally:
        with state.monitores_lock:
            if porta in state.monitores_individuais:
                del state.monitores_individuais[porta]
        with state.lock: print(f"  🛑 [WEB REQUEST] Monitoramento encerrado na porta {porta}")

def watch_codigos_porta(porta, numero, ser, ids_processados, is_huawei=False):
    memorias = MEMORIAS_HUAWEI if is_huawei else MEMORIAS_PADRAO
    todas_sms = []
    try:
        todas_sms = ler_sms_completo(ser, is_huawei, pdu_primario=is_huawei)
        for sms in todas_sms:
            texto = sms.get("texto", "").strip()
            
            # ============================================
            # [DEBUG RAW] LOG BRUTO - MOSTRA TUDO QUE CHEGA (ANTES DE QUALQUER FILTRO)
            print(f"\n  {'='*55}")
            print(f"  🚨 [SMS BRUTO] Numero: {numero} | Porta: {porta}")
            print(f"  📩 TEXTO COMPLETO: {repr(texto)}")
            # Filtro Inteligente: Pega apenas o primeiro bloco de 4 a 8 dígitos (evita lixo do final do SMS)
            digits_match = re.search(r'\d{4,8}', texto)
            if digits_match:
                digits = digits_match.group(0)
                print(f"  🔑 CÓDIGO CANDIDATO: {digits}")
            print(f"  {'='*55}\n")
            # ============================================
            
            msg_id = f"{numero}:{texto}"
            if not texto or msg_id in ids_processados: continue
            
            srv_id, servico, codigo = detectar_servico(texto)
            if not srv_id or not codigo: srv_id, servico, codigo = None, "Desconhecido", texto[:15]+"..."
            
            item = {"servico": servico, "codigo": codigo, "numero": numero, "porta": porta, "grid": state.mapa_usb.get(porta, {}).get("grid", "??"), "timestamp": time.strftime('%H:%M:%S')}
            ids_processados.add(msg_id)
            with state.fila_lock: state.fila_codigos.append(item)
            
            # Print para o terminal após identificação
            if srv_id:
                print(f"  [{time.strftime('%H:%M:%S')}] ✅ [MATCH] {servico}: {codigo} -> {numero}")
            else:
                print(f"  [{time.strftime('%H:%M:%S')}] ⚠️  [SEM MATCH] SMS não reconhecido. NÃO enviado para nuvem.")
            
            # Sincroniza com a nuvem (Supabase SaaS)
            sync_sms_to_cloud(numero, (codigo if srv_id else texto), srv_id)
            
            # [LIMPEZA AGRESSIVA] Deleta o SMS imediatamente após captura
            try:
                from modems.core import enviar_comando
                idx = sms.get("index")
                if idx and str(idx).isdigit():
                    enviar_comando(ser, f"AT+CMGD={idx}", timeout=0.2)
                    print(f"  🗑️ [CLEAN] SMS index {idx} deletado do chip imediatamente.")
            except: pass

            try: salvar_sms_historico(numero, porta, servico, codigo, texto)
            except: pass
    finally:
        _limpar_todos_sms(ser, memorias, todas_sms)

def tarefa_watch_porta(porta, numero):
    grid = state.mapa_usb.get(porta, {}).get("grid", "??")
    ids_processados = set()
    try:
        ser = abrir_serial_simples(porta)
        if not ser: return
        with ser:
            from modems.core import ativar_notificacoes_imediatas, enviar_comando
            print(f"  📡 [MODEM {porta}] Ativando ESCUTA ATIVA REAL-TIME...")
            ativar_notificacoes_imediatas(ser)
            is_huawei = detectar_huawei(ser)
            
            ultimo_safety_check = time.time()
            buffer_acumulado = ""
            
            while not state.stop_watch.is_set():
                # Leitura não bloqueante com timeout curto (0.1s definido no Serial)
                if ser.in_waiting:
                    linha = ser.read(ser.in_waiting).decode(errors='ignore')
                    buffer_acumulado += linha
                    
                    # Se detectarmos um indicativo de SMS (+CMT ou +CMTI)
                    if "+CMT" in buffer_acumulado or "+CMTI" in buffer_acumulado:
                        # Espera um milissegundo para o resto chegar
                        time.sleep(0.2)
                        buffer_acumulado += ser.read_all().decode(errors='ignore')
                        
                        # Processa o que chegou
                        processar_sms_instantaneo(buffer_acumulado, numero, porta, grid, ids_processados)
                        
                        # Limpa buffer e deleta do chip (limpeza agressiva)
                        enviar_comando(ser, "AT+CMGD=1,4", timeout=0.5)
                        buffer_acumulado = ""
                
                # Fallback: Varredura de segurança a cada 30 segundos
                if time.time() - ultimo_safety_check > 30:
                    todas_sms = ler_sms_completo(ser, is_huawei)
                    for sms in todas_sms:
                        processar_sms_instantaneo(sms["texto"], numero, porta, grid, ids_processados)
                    enviar_comando(ser, "AT+CMGD=1,4", timeout=0.5)
                    ultimo_safety_check = time.time()
                
                time.sleep(0.01) # Ciclo ultra-rápido de 10ms
    except Exception as e: 
        print(f"  ❌ Erro Crítico em {porta}: {e}")

def watch_all(lista_portas_numeros):
    print(f"\n  👁️ MODO WATCH — Monitorando {len(lista_portas_numeros)} modems...")
    state.stop_watch.clear()
    for porta, numero in lista_portas_numeros:
        threading.Thread(target=tarefa_watch_porta, args=(porta, numero), daemon=True).start()
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        state.stop_watch.set()
