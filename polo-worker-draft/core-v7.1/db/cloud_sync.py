import os
import time
import requests
import base64
from dotenv import load_dotenv

# Carrega variáveis de ambiente
load_dotenv()

SUPABASE_URL = os.getenv("SUPABASE_URL")
if SUPABASE_URL and SUPABASE_URL.endswith('/'):
    SUPABASE_URL = SUPABASE_URL[:-1]
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_KEY") # Usamos service_key para bypassar RLS e gerenciar hardware
BACKEND_URL = (os.getenv("BACKEND_URL") or "").rstrip("/")
PARTNER_API_KEY = os.getenv("PARTNER_API_KEY") or os.getenv("HARDWARE_API_KEY") or ""

_current_polo_id = None

def get_headers():
    return {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=representation"
    }

def scramble_sms(text):
    """Ofuscação simples para o trânsito e banco de dados."""
    if not text: return ""
    # Inverte e converte para Base64
    return base64.b64encode(text[::-1].encode()).decode()

def _deliver_sms_via_backend(activation_id, sms_code):
    """Entrega oficial via backend /sms/deliver (fonte única de ingestão)."""
    if not BACKEND_URL:
        print("  ⚠️  [SMS API] BACKEND_URL ausente; entrega via backend desativada.")
        return False
    if not PARTNER_API_KEY:
        print("  ⚠️  [SMS API] PARTNER_API_KEY/HARDWARE_API_KEY ausente; entrega via backend desativada.")
        return False
    try:
        url = f"{BACKEND_URL}/sms/deliver"
        headers = {
            "Authorization": f"Bearer {PARTNER_API_KEY}",
            "Content-Type": "application/json",
        }
        payload = {
            "activation_id": activation_id,
            "sms_code": sms_code,
        }
        resp = requests.post(url, json=payload, headers=headers, timeout=12)
        if resp.status_code == 200:
            return True
        detail = ""
        try:
            detail = str(resp.json())
        except Exception:
            detail = resp.text[:200]
        print(f"  ⚠️  [SMS API] /sms/deliver falhou ({resp.status_code}): {detail}")
        return False
    except Exception as e:
        print(f"  ⚠️  [SMS API] erro de rede ao entregar SMS: {e}")
        return False

def init_polo():
    """Inicializa o polo APENAS se a chave já existir no servidor."""
    global _current_polo_id
    if not SUPABASE_URL or not SUPABASE_KEY:
        print("⚠️ Erro: SUPABASE_URL ou SUPABASE_SERVICE_KEY ausentes no .env!")
        return False, None

    chave = os.getenv("POLO_KEY")
    if not chave:
        print("⚠️ POLO_KEY ausente no .env. Defina a CHAVE DO PARCEIRO correta para continuar.")
        return False, None

    try:
        headers = get_headers()
        resp = requests.get(f"{SUPABASE_URL}/rest/v1/polos?chave_acesso=eq.{chave}&select=*", headers=headers)
        if resp.status_code == 200 and len(resp.json()) > 0:
            polo_data = resp.json()[0]
            _current_polo_id = polo_data["id"]
            polo_nome = polo_data.get("nome", "Polo Ativo")

            # Atualiza status
            update_data = {
                "status": "ONLINE",
                "ultima_comunicacao": "now()"
            }
            requests.patch(f"{SUPABASE_URL}/rest/v1/polos?id=eq.{_current_polo_id}", json=update_data, headers=headers)
            
            # [MANUTENÇÃO] Aciona limpeza de dados antigos (> 15 dias)
            try: requests.post(f"{SUPABASE_URL}/rest/v1/rpc/rpc_cleanup_old_data", headers=headers)
            except: pass
            
            return True, polo_nome
        else:
            print("⚠️ CHAVE DO PARCEIRO inválida ou não vinculada. O core não irá auto-criar polo.")
            return False, None

    except Exception as e:
        print(f"⚠️ Erro de rede ao conectar Polo: {e}")
        return False, None

def sync_chip_to_cloud(porta, numero, operadora):
    """Sincroniza o chip diretamente na tabela 'chips' global, visível no web."""
    global _current_polo_id
    if not _current_polo_id or not SUPABASE_URL: return

    # Garante que usamos apenas o número, mesmo se vier como CCID:XXXX|55...
    numero_limpo = str(numero).split("|")[1] if "|" in str(numero) else str(numero)

    try:
        headers = get_headers()
        # Busca se a porta já existe PARA ESTE POLO específico
        resp_get = requests.get(f"{SUPABASE_URL}/rest/v1/chips?porta=eq.{porta}&polo_id=eq.{_current_polo_id}&select=*", headers=headers)
        
        data = {
            "polo_id": _current_polo_id,
            "porta": porta,
            "numero": numero_limpo,
            "status": "idle" # Força status idle para ficar disponível para SMS
        }
        
        if resp_get.status_code == 200 and len(resp_get.json()) > 0:
            chip_id = resp_get.json()[0]["id"]
            resp_update = requests.patch(f"{SUPABASE_URL}/rest/v1/chips?id=eq.{chip_id}", json=data, headers=headers)
            if resp_update.status_code in (200, 204):
                print(f"  [OK] Chip {numero} enviado para a nuvem com sucesso! (Atualizado na {porta})")
        else:
            resp_insert = requests.post(f"{SUPABASE_URL}/rest/v1/chips", json=data, headers=headers)
            if resp_insert.status_code in (200, 201):
                print(f"  [OK] Chip {numero} enviado para a nuvem com sucesso! (Novo na {porta})")
            else:
                print(f"  ⚠️ Erro inserindo chip: {resp_insert.text}")
                
    except Exception as e:
        print(f"  ⚠️  [CLOUD] Erro de rede ao sincronizar chip: {e}")

def sync_sms_to_cloud(numero, texto, servico_id=None):
    """Envia o SMS recebido para a ativação pendente (lookup no Supabase + entrega no backend)."""
    if not SUPABASE_URL: return False
    
    # Se não houver serviço reconhecido, não envia para a nuvem por privacidade
    if not servico_id:
        print(f"  ☁️  [CLOUD] SMS ignorado (Serviço não reconhecido/proteção de privacidade)")
        return False

    # Garante que usamos apenas o número, mesmo se vier como CCID:XXXX|55...
    numero_limpo = str(numero).split("|")[1] if "|" in str(numero) else str(numero)

    try:
        headers = get_headers()
        # 1. Busca a ativação 'waiting' que bata com o NÚMERO e o SERVIÇO solicitado
        query = f"phone_number=eq.{numero_limpo}&status=eq.waiting&service=eq.{servico_id}&order=created_at.desc&limit=1&select=*"
        resp_act = requests.get(f"{SUPABASE_URL}/rest/v1/activations?{query}", headers=headers)
        
        if resp_act.status_code == 200 and len(resp_act.json()) > 0:
            activation = resp_act.json()[0]
            act_id = activation["id"]
            if _deliver_sms_via_backend(act_id, texto):
                print(f"  ☁️  [CLOUD] SMS entregue via backend para ativação {act_id[:8]} ({servico_id})")
                return True
            print(f"  ☁️  [CLOUD] SMS localizado para {act_id[:8]}, mas entrega no backend falhou.")
            return False
        else:
            # Em vez de erro, logamos como INFO discreto (pode ser spam ou SMS atrasado)
            print(f"  ☁️  [INFO] SMS ignorado para {numero_limpo} [{servico_id}] (Sem ativação pendente)")
            return False
            
    except Exception as e:
        print(f"  ⚠️  [CLOUD] Erro de rede ao sincronizar SMS: {e}")
        return False

def set_all_offline():
    """Define este_polo e os chips associados como offline."""
    global _current_polo_id
    if not _current_polo_id or not SUPABASE_URL: return
    
    try:
        headers = get_headers()
        # Coloca o Polo offline
        requests.patch(f"{SUPABASE_URL}/rest/v1/polos?id=eq.{_current_polo_id}", json={"status": "OFFLINE", "chips_ativos": 0}, headers=headers)
        print("  ☁️  [CLOUD] Polo setado como OFFLINE")
        
        # Coloca os chips OFFLINE (penas os DESTE POLO para não derrubar as outras máquinas)
        requests.patch(f"{SUPABASE_URL}/rest/v1/chips?polo_id=eq.{_current_polo_id}", json={"status": "offline"}, headers=headers)
        print(f"  ☁️  [CLOUD] Base de dados limpa (Chips do Polo {_current_polo_id[:8]} Offline)")
    except Exception as e: 
        print(f"Erro offline: {e}")

def heartbeat_polo():
    """Atualiza o 'visto por último' para manter o status ONLINE no painel."""
    global _current_polo_id
    if not _current_polo_id or not SUPABASE_URL: return
    try:
        headers = get_headers()
        data = {"status": "ONLINE", "ultima_comunicacao": "now()"}
        requests.patch(f"{SUPABASE_URL}/rest/v1/polos?id=eq.{_current_polo_id}", json=data, headers=headers)
    except: pass

