import sqlite3
import re
from config import DB_HISTORICO_ARQUIVO

def iniciar_banco():
    """Inicia o banco de dados historico.db verificando se a tabela existe."""
    conn = sqlite3.connect(DB_HISTORICO_ARQUIVO)
    cursor = conn.cursor()
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS historico_numeros (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            numero TEXT UNIQUE NOT NULL,
            data_inclusao TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS historico_sms (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            numero TEXT,
            porta TEXT,
            servico TEXT,
            codigo_verificacao TEXT,
            texto_bruto TEXT,
            data_inclusao TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    # Auto-Limpeza: Apaga Códigos com mais de 24 horas (ajuda a poupar espaço)
    try:
        cursor.execute("DELETE FROM historico_sms WHERE data_inclusao <= datetime('now', '-1 day')")
    except Exception:
        pass
    conn.commit()
    conn.close()

def salvar_numero_historico(numero_bruto):
    """
    Adiciona o número ao banco de dados historico.db.
    Substitui o antigo mecanismo de TXT por SQLite garantindo integridade.
    """
    if not numero_bruto or "CCID:" in str(numero_bruto) or "Falha" in str(numero_bruto):
        return

    num_limpo = re.sub(r'\D', '', str(numero_bruto))
    
    # Se já começar com 55 e tiver tamanho válido, tira o 55 provisoriamente
    if num_limpo.startswith("55") and len(num_limpo) >= 12:
        num_limpo = num_limpo[2:]
        
    # Se vier sem o 9 (10 dígitos), adiciona o 9 após o DDD
    if len(num_limpo) == 10:
        num_limpo = num_limpo[:2] + '9' + num_limpo[2:]
        
    # Só aceita se encaixar perfeitamente no formato de 11 dígitos Brasil
    if len(num_limpo) == 11:
        num_final = "55" + num_limpo
    else:
        return

    iniciar_banco()
    conn = sqlite3.connect(DB_HISTORICO_ARQUIVO)
    cursor = conn.cursor()
    try:
        cursor.execute("INSERT OR IGNORE INTO historico_numeros (numero) VALUES (?)", (num_final,))
        conn.commit()
    except Exception as e:
        print(f"Erro ao salvar no banco de dados: {e}")
    finally:
        conn.close()

def obter_todos_os_numeros():
    """Retorna uma lista de todos os números salvos no histórico."""
    iniciar_banco()
    conn = sqlite3.connect(DB_HISTORICO_ARQUIVO)
    cursor = conn.cursor()
    cursor.execute("SELECT numero FROM historico_numeros ORDER BY data_inclusao DESC")
    numeros = [linha[0] for linha in cursor.fetchall()]
    conn.close()
    return numeros

def salvar_sms_historico(numero, porta, servico, codigo_verificacao, texto_bruto):
    """
    Salva permanentemente um SMS recebido no banco de dados SQLite, evitando duplicatas recentes.
    """
    iniciar_banco()
    conn = sqlite3.connect(DB_HISTORICO_ARQUIVO)
    cursor = conn.cursor()
    try:
        # Anti-Duplicata: Verifica se este MESMO código já foi salvo hoje para este número
        if codigo_verificacao:
            cursor.execute('''
                SELECT id FROM historico_sms 
                WHERE numero = ? AND codigo_verificacao = ? AND data_inclusao > datetime('now', '-1 day')
            ''', (str(numero), str(codigo_verificacao)))
            if cursor.fetchone():
                return  # Já existe, ignora a duplicata!
            
        cursor.execute('''
            INSERT INTO historico_sms (numero, porta, servico, codigo_verificacao, texto_bruto)
            VALUES (?, ?, ?, ?, ?)
        ''', (str(numero), str(porta), str(servico), str(codigo_verificacao), str(texto_bruto)))
        conn.commit()
    except Exception as e:
        print(f"Erro ao salvar SMS no banco de dados: {e}")
    finally:
        conn.close()

def obter_ultimos_sms(limite=500):
    """Retorna os últimos SMS salvos no formato de lista de dicionários."""
    iniciar_banco()
    conn = sqlite3.connect(DB_HISTORICO_ARQUIVO)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    cursor.execute('''
        SELECT id, numero, porta, servico, codigo_verificacao, texto_bruto,
               datetime(data_inclusao, 'localtime') as data_hora
        FROM historico_sms
        ORDER BY id DESC LIMIT ?
    ''', (limite,))
    
    linhas = cursor.fetchall()
    conn.close()
    
    resultado = []
    for l in linhas:
        resultado.append(dict(l))
    return resultado

