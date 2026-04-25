import time
import state
from config import PREFIXO_CCID, STATUS_FALHAS

def log(porta, msg, simbolo="►"):
    """Log thread-safe com timestamp e posição no grid."""
    grid = state.mapa_usb.get(porta, {}).get("grid", "??")
    with state.lock:
        print(f"  [{time.strftime('%H:%M:%S')}] {simbolo} {porta:<8} [{grid}] | {msg}")

def exibir_mapa_hub():
    from modems.detection import parsear_ccid
    from config import HUB_LINHAS, HUB_COLUNAS
    letras = "ABCD"

    print("\n  🗺️  MAPA DO HUB (Localização Física)")
    print("  ┌────────┬────────┬────────┬────────┐")
    print("  │   1    │   2    │   3    │   4    │")
    print("  ├────────┼────────┼────────┼────────┤")

    grid_to_porta = {info["grid"]: porta for porta, info in state.mapa_usb.items()}

    for l in range(HUB_LINHAS):
        letra = letras[l]
        celulas = []
        for c in range(1, HUB_COLUNAS + 1):
            grid = f"{letra}{c}"
            porta = grid_to_porta.get(grid, "")
            if porta and porta in state.resultados:
                num = state.resultados[porta]
                if num not in STATUS_FALHAS:
                    if num.startswith(PREFIXO_CCID):
                        ccid_v, num_v = parsear_ccid(num)
                        if num_v: celulas.append(f"•{num_v[-4:]}")
                        else: celulas.append(f"#{ccid_v[-4:]}")
                    else: celulas.append(f"•{num[-4:]}")
                else: celulas.append("  ❌  ")
            else: celulas.append("  --  ")

        print(f"{letra} │{celulas[0]:^8}│{celulas[1]:^8}│{celulas[2]:^8}│{celulas[3]:^8}│")
        if l < HUB_LINHAS - 1:
            print("  ├────────┼────────┼────────┼────────┤")

    print("  └────────┴────────┴────────┴────────┘")

def exibir_resultados(lista_ordenada):
    from modems.detection import parsear_ccid
    ok = sum(1 for _, n in lista_ordenada if n not in STATUS_FALHAS)
    falha = len(lista_ordenada) - ok
    arquia_count = sum(1 for _, n in lista_ordenada if n.startswith(PREFIXO_CCID))

    print("\n" + "="*60)
    print(f"  {'ID':<4} | {'LOCAL':<5} | {'PORTA':<8} | {'NÚMERO / CCID'}")
    print(f"  Encontrados: {ok} ✅  |  Falhas: {falha} ❌", end="")
    if arquia_count: print(f"  |  Arquia: {arquia_count} 🔶")
    else: print()
    print("-" * 60)
    
    for i, (porta, num) in enumerate(lista_ordenada, 1):
        grid = state.mapa_usb.get(porta, {}).get("grid", "??")
        if num.startswith(PREFIXO_CCID):
            ccid_v, num_v = parsear_ccid(num)
            if num_v: print(f"  [{i:<2}] | {grid:<5} | {porta:<8} | {num_v} (CCID:...{ccid_v[-4:]}) 🔶")
            else: print(f"  [{i:<2}] | {grid:<5} | {porta:<8} | CCID: {ccid_v} 🔶")
        elif num not in STATUS_FALHAS:
            print(f"  [{i:<2}] | {grid:<5} | {porta:<8} | {num} ✅")
        else:
            print(f"  [{i:<2}] | {grid:<5} | {porta:<8} | {num} ❌")
    print("-" * 60)
