import os
import time
import threading
import subprocess
import ctypes
import sys
import signal
import atexit
sys.stdout.reconfigure(encoding='utf-8')

# Garante que o diretório raiz está no path para importar modulos
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

import state
from config import TIMEOUT_USSD, TENTATIVAS_MAX, STATUS_FALHAS
from modems.detection import carregar_calibracao, carregar_ccid_numeros, filtrar_portas_at, tarefa_identificar_porta
from modems.monitor import monitorar_sms, watch_all
from db.cloud_sync import set_all_offline, init_polo, heartbeat_polo
from web.utils_display import exibir_mapa_hub, exibir_resultados

def desabilitar_quickedit():
    try:
        if os.name == 'nt':
            kernel32 = ctypes.windll.kernel32
            handle = kernel32.GetStdHandle(-10) # STD_INPUT_HANDLE
            mode = ctypes.c_uint32()
            kernel32.GetConsoleMode(handle, ctypes.byref(mode))
            mode.value &= ~0x0040 # Disable ENABLE_QUICK_EDIT_MODE
            kernel32.SetConsoleMode(handle, mode)
    except: pass

PROCESSOS_INDESEJADOS = [
    "Mobile Partner.exe", "MobilePartner.exe", "DataCardMonitor.exe",
    "HiSuiteService.exe", "HiSuite.exe", "ClaroChip.exe", "AutoPlay.exe",
]

def matar_processos_claro():
    for proc in PROCESSOS_INDESEJADOS:
        try:
            resultado = subprocess.run(["taskkill", "/F", "/IM", proc], capture_output=True, text=True, timeout=5)
            if resultado.returncode == 0:
                print(f"  ✅ Processo '{proc}' encerrado com sucesso")
        except: pass

def handle_exit(*args):
    """Garante que o Polo e os Chips fiquem offline ao fechar."""
    print("\n\n  🚪 Sinal de encerramento detectado. Limpando estado na nuvem...")
    try:
        from db.cloud_sync import set_all_offline
        set_all_offline()
    except: pass
    sys.exit(0)

# Registra os handlers de saída
atexit.register(handle_exit)
signal.signal(signal.SIGINT, handle_exit)
signal.signal(signal.SIGTERM, handle_exit)

def rotina_principal():
    print("\n" + "="*60)
    print("        GSM CODDER - Identificador de Números (Modular)")
    print("     Compatível com Quectel e Huawei E303")
    print("="*60)

    # Define apenas os DESTE polo como offline antes de começar a nova varredura
    set_all_offline()

    # Polo Initialization for pure HTTP Sync
    success, polo_nome = init_polo()
    if success:
        print(f"  📡 Polo [{polo_nome}] conectado com sucesso.")
    else:
        print("  ❌ Falha ao inicializar o Polo na nuvem. Encerrando para evitar sync em polo errado.")
        return

    # Heartbeat thread para manter o status ONLINE no painel
    def polo_heartbeat_loop():
        while True:
            heartbeat_polo()
            time.sleep(30)
    
    hb_thread = threading.Thread(target=polo_heartbeat_loop, daemon=True)
    hb_thread.start()

    carregar_calibracao()
    carregar_ccid_numeros()

    todas_portas = filtrar_portas_at()
    if not todas_portas:
        print("  ❌ Nenhuma porta encontrada.")
        return

    state.total_portas = len(todas_portas)
    state.portas_concluidas = 0
    state.resultados.clear()
    state.varredura_completa = False

    print(f"  📋 {state.total_portas} portas para varredura")
    print(f"  ⏱  Timeout USSD: {TIMEOUT_USSD}s | Tentativas: {TENTATIVAS_MAX}")
    print("-"*60 + "\n")

    threads = []
    for porta in todas_portas:
        t = threading.Thread(target=tarefa_identificar_porta, args=(porta,), daemon=True)
        threads.append(t)
        t.start()
        time.sleep(1)

    try:
        for t in threads:
            t.join(timeout=TIMEOUT_USSD * TENTATIVAS_MAX + 30)
    finally:
        state.varredura_completa = True

    print("\n" + "="*60)
    print("  ✅ Varredura concluída!")
    print("="*60)

    exibir_mapa_hub()

    # --- AUTO-WATCH ---
    # Ao terminar a varredura, já iniciamos o monitoramento de todos os números válidos na nuvem
    lista_ordenada = sorted(state.resultados.items(), key=lambda x: state.mapa_usb.get(x[0], {}).get("slot", 99))
    exibir_resultados(lista_ordenada)
    validos = [(p, n) for p, n in lista_ordenada if n not in STATUS_FALHAS]
    
    if validos:
        print(f"\n  🚀 INICIANDO MONITORAMENTO AUTOMÁTICO ({len(validos)} modems)...")
        print(f"  (Aguardando SMS para enviar para o seu site)")
        watch_all(validos)
    else:
        print("\n  ⚠️ Nenhum número válido detectado para monitoramento.")

    while True:
        # Se chegamos aqui, o watch foi encerrado ou não iniciou
        print(f"\n  Comandos:")
        print(f"  R       = 🔄 Atualizar lista (Rodar varredura novamente)")
        print(f"  S       = 🚪 Sair")
        opcao = input("\n  Opção: ").strip().upper()

        if opcao == 'S':
            print("  Encerrando...")
            set_all_offline()
            break
        elif opcao == 'R':
            return rotina_principal()

if __name__ == "__main__":
    desabilitar_quickedit()
    print("\n🔒 Verificando processos que travam modems...")
    matar_processos_claro()
    print("✅ Verificação concluída\n")
    rotina_principal()
