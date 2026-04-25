import os
from dotenv import load_dotenv

def _safe_load_dotenv():
    """Evita AssertionError do python-dotenv no runtime empacotado (.pyc)."""
    env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
    try:
        if os.path.exists(env_path):
            load_dotenv(dotenv_path=env_path, override=False)
        else:
            load_dotenv(override=False)
    except AssertionError:
        # Fallback sem introspecção de stack (find_dotenv pode quebrar no app empacotado).
        pass

# Carrega as variáveis do arquivo .env (quando existir)
_safe_load_dotenv()

def _resolve_data_dir():
    """Diretório gravável para runtime (evita readonly no app empacotado)."""
    env_dir = os.getenv("FLUXSMS_DATA_DIR", "").strip()
    if env_dir:
        base = env_dir
    else:
        base = os.path.join(os.getcwd(), "data")
    os.makedirs(base, exist_ok=True)
    return base

DATA_DIR = _resolve_data_dir()

# --- Arquivos de Dados e Banco ---
MAPA_HUB_ARQUIVO = os.path.join(DATA_DIR, "mapa_hub.json")
CCID_NUMEROS_ARQUIVO = os.path.join(DATA_DIR, "ccid_numeros.json")
DB_HISTORICO_ARQUIVO = os.path.join(DATA_DIR, "historico_sms.db")

# --- Configurações do Desenho do Hub (Visual) ---
HUB_LINHAS = 4
HUB_COLUNAS = 4

# --- Configurações Cruciais de Sistema ---
MAX_THREADS = 8
TIMEOUT_USSD = 15
TENTATIVAS_MAX = 2

# --- Status Operacionais ---
STATUS_ERRO = "Erro"
STATUS_OCUPADA = "Ocupada"
STATUS_SEM_CHIP = "Sem Chip"
STATUS_FALHA = "Falha"
STATUS_SEM_AT = "Sem Resposta AT"
STATUS_FALHAS = [STATUS_FALHA, STATUS_SEM_CHIP, "Timeout", STATUS_ERRO, STATUS_SEM_AT]

# --- Configurações de Conexão Serial ---
BAUD_RATE = 115200
BAUD_RATE_FALLBACK = 9600
RETRY_PORTA = 3
RETRY_PORTA_DELAY = 1.0
SCAN_TIMEOUT = 1.5
MEMORIAS_HUAWEI = ["SM", "ME", "MT"]
MEMORIAS_PADRAO = ["SM", "ME", "MT"]
# SMS_POLL_INTERVAL removido: agora usando Escuta Ativa (Event-Driven)

# --- Configurações de Web ---
NGROK_AUTH_TOKEN = os.getenv("NGROK_AUTH_TOKEN", "")
NGROK_DOMAIN = os.getenv("NGROK_DOMAIN", "")
PREFIXO_CCID = "CCID:"

# --- Mapeamento de Operadoras (MNC) ---
OPERADORA_MNCS = {
    "72402": "tim", "72403": "tim", "72404": "tim",
    "72405": "claro", "72438": "claro",
    "72406": "vivo", "72410": "vivo", "72411": "vivo",
    "72431": "oi", "72416": "oi",
}

def get_web_users():
    users_env = os.getenv("WEB_USERS", "admin:admin")
    users = {}
    for entry in users_env.split(','):
        if ':' in entry:
            u, p = entry.split(':', 1)
            users[u] = p
    return users

def save_web_users(users_dict):
    from dotenv import set_key
    user_string = ",".join([f"{u}:{p}" for u, p in users_dict.items()])
    set_key(".env", "WEB_USERS", user_string)

# --- REGRAS DE DETECÇÃO DE SERVIÇOS (SMS) ---
SERVICOS_ORDEM = ["google", "whatsapp", "telegram", "facebook", "tiktok", "instagram", "uber", "99", "generic"]
SERVICOS = {
    "google": {"nome": "Google / YouTube", "keywords": ["google", "g-"], "codigo_regex": r"(?:G-)?(\d{4,8})"},
    "whatsapp": {"nome": "WhatsApp", "keywords": ["whatsapp", "viber"], "codigo_regex": r"(\d{3})[-\s]?(\d{3})"},
    "telegram": {"nome": "Telegram", "keywords": ["telegram", "t.me", "tg code"], "codigo_regex": r"(\d{5,6})"},
    "facebook": {"nome": "Facebook", "keywords": ["facebook", "fb-"], "codigo_regex": r"(?:fb-)?(\d{4,8})"},
    "tiktok": {"nome": "TikTok", "keywords": ["tiktok"], "codigo_regex": r"(\d{4,6})"},
    "instagram": {"nome": "Instagram", "keywords": ["instagram"], "codigo_regex": r"(\d{5,8})"},
    "uber": {"nome": "Uber", "keywords": ["uber"], "codigo_regex": r"(\d{4})"},
    "99": {"nome": "99 App", "keywords": ["99app", "99 pay"], "codigo_regex": r"(\d{4,6})"},
    "generic": {"nome": "Código Genérico", "keywords": ["código", "verificação", "code", "verificacao"], "codigo_regex": r"(\d{4,8})"}
}
