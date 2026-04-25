import os
import time
import threading
import sys
import ctypes

# Garante que o diretório raiz está no path para importar modulos
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

import state
from config import TIMEOUT_USSD, TENTATIVAS_MAX, STATUS_FALHAS
from modems.detection import carregar_calibracao, carregar_ccid_numeros, filtrar_portas_at, tarefa_identificar_porta
from modems.monitor import watch_all
from db.cloud_sync import set_all_offline, init_polo

# Usaremos requests para enviar as mensagens lidas pro Supabase da nuvem
try:
    import requests
except ImportError:
    print("O módulo 'requests' não está instalado. Feche e rode: pip install requests")
    sys.exit(1)

def desabilitar_quickedit():
    try:
        if os.name == 'nt':
            kernel32 = ctypes.windll.kernel32
            handle = kernel32.GetStdHandle(-10)
            mode = ctypes.c_uint32()
            kernel32.GetConsoleMode(handle, ctypes.byref(mode))
            mode.value &= ~0x0040
            kernel32.SetConsoleMode(handle, mode)
    except: pass

def clear_screen():
    os.system('cls' if os.name == 'nt' else 'clear')

def logo():
    clear_screen()
    print("="*60)
    print("      🌟 FLUXNODE - TRABALHADOR DE POLO FLUXSMS 🌟")
    print("             Envio Automático para Nuvem")
    print("="*60 + "\n")

def setup_node():
    logo()
    env_file = os.path.join(os.path.dirname(__file__), ".fluxnode")
    node_key = ""
    
    if os.path.exists(env_file):
        with open(env_file, "r") as f:
            node_key = f.read().strip()
            
    if not node_key:
        print("🔧 Configuração Inicial da Máquina 🔧")
        node_key = input("👉 Cole a Chave Mestra gerada no Painel Admin: ").strip()
        if node_key:
            with open(env_file, "w") as f:
                f.write(node_key)
            print("✅ Chave salva com sucesso!\n")
        else:
            print("❌ Nenhuma chave inserida. Saindo...")
            sys.exit(1)
            
    return node_key

# Modificando a função de upload do modems.monitor para salvar na nuvem
# A lógica de watch_all será adaptada para um loop infinito sem UI

def varredura_inicial():
    print("📡 Iniciando varredura profunda nas portas COM...")
    
    set_all_offline()
    carregar_calibracao()
    carregar_ccid_numeros()

    todas_portas = filtrar_portas_at()
    if not todas_portas:
        print("❌ Nenhuma porta encontrada! Verifique os cabos USB e Hubs.")
        return False

    state.total_portas = len(todas_portas)
    state.portas_concluidas = 0
    state.resultados.clear()
    state.varredura_completa = False

    threads = []
    for porta in todas_portas:
        t = threading.Thread(target=tarefa_identificar_porta, args=(porta,), daemon=True)
        threads.append(t)
        t.start()
        time.sleep(0.5)

    try:
        for t in threads:
            t.join(timeout=TIMEOUT_USSD * TENTATIVAS_MAX + 10)
    finally:
        state.varredura_completa = True

    print("✅ Varredura concluída!")
    return True

def node_loop(node_key):
    logo()
    print(f"🔗 Polo Validando Chave: {node_key[:12]}...")
    
    if not init_polo(node_key):
        print("❌ Erro: Chave inválida ou bloqueada pelo Admin! O sistema será resetado.")
        # Remove a chave ruim se existir
        env_file = os.path.join(os.path.dirname(__file__), ".fluxnode")
        if os.path.exists(env_file):
            os.remove(env_file)
        input("\nPressione Enter para sair...")
        sys.exit(1)
        
    print("✅ Polo Validado e Liberado pela Nuvem!")
    
    if not varredura_inicial():
        input("\nPressione Enter para sair...")
        sys.exit(1)

    lista_ordenada = sorted(state.resultados.items(), key=lambda x: state.mapa_usb.get(x[0], {}).get("slot", 99))
    validos = [(p, n) for p, n in lista_ordenada if n not in STATUS_FALHAS]
    
    print(f"\n🚀 Iniciando extração contínua em {len(validos)} chips validados para a nuvem...")
    print("O Dashboard na nuvem cuidará da distribuição.")
    print("Você pode minimizar esta tela.\n")
    
    # Aqui vamos invocar a função watch_all, MAS ELA PRECISA SER ADAPTADA (cloud_sync)
    # Atualmente a cloud_sync tenta salvar via web ou local. Vamos substituir o cloud_sync.
    watch_all(validos)


if __name__ == "__main__":
    desabilitar_quickedit()
    chave = setup_node()
    node_loop(chave)
