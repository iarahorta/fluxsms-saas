import threading
from collections import deque
from config import MAX_THREADS

# Resultados da varredura
resultados       = {}           # porta -> número ou status de erro
mapa_usb         = {}           # porta -> {"imei", "grid", "slot"}
mapa_calibrado   = {}           # IMEI  -> {"slot", "grid"}
ccid_numeros     = {}           # CCID  -> número

# Locks de sincronização
lock             = threading.Lock()
semaforo         = threading.Semaphore(MAX_THREADS)
contador_lock    = threading.Lock()
fila_lock        = threading.Lock()
monitores_lock   = threading.Lock()

# Contadores e Estados Operacionais
total_portas      = 0
portas_concluidas = 0
codigos_total     = 0

# Fila de códigos detectados para a Web
fila_codigos = deque(maxlen=100)

# Controle de Threads de Monitoramento
monitores_individuais = {} # {porta: event}
stop_watch = threading.Event()
watch_global_ativo = False
varredura_completa = False # Usada apenas internamente agora

# Status (Mantido vazio para compatibilidade, mas sem uso na UI)
status_monitores = {}
