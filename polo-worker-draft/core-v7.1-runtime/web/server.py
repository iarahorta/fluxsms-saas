import logging
import threading
import time
import re
from flask import Flask, jsonify, render_template_string, request, Response
from pyngrok import ngrok
from functools import wraps
from config import NGROK_AUTH_TOKEN, NGROK_DOMAIN, get_web_users
import state
from modems.core import abrir_serial_simples, enviar_comando, limpar_buffer, detectar_huawei, ler_sms_completo, _limpar_todos_sms
from modems.detection import parsear_ccid
from modems.monitor import thread_monitor_individual, detectar_servico

app = Flask(__name__)
log_flask = logging.getLogger('werkzeug')
log_flask.setLevel(logging.ERROR)

def check_auth(username, password):
    users = get_web_users()
    return username in users and users[username] == password

def authenticate():
    return Response('Acesso restrito.', 401, {'WWW-Authenticate': 'Basic realm="Login Required"'})

def requires_auth(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        auth = request.authorization
        if not auth or not check_auth(auth.username, auth.password): return authenticate()
        return f(*args, **kwargs)
    return decorated

TEMPLATE_HTML = """
<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <title>GSM HUB - CLEAN</title>
    <style>
        body { font-family: monospace; background-color: #000; color: #00FF00; margin: 0; padding: 20px; overflow-x: hidden; }
        .container { max-width: 1100px; margin: 0 auto; }
        h1 { border-bottom: 2px solid #00FF00; padding-bottom: 10px; margin-bottom: 30px; font-size: 1.8em; }
        
        .grid-numeros { display: flex; flex-wrap: wrap; gap: 15px; margin-bottom: 30px; }
        .chip-box { background: #111; border: 1px solid #333; padding: 15px; width: 230px; position: relative; transition: all 0.3s; }
        .chip-box.monitorando { border-color: #00FF00; background: #001a00; border-width: 2px; }
        .chip-box.desabilitado { opacity: 0.3; filter: grayscale(1); pointer-events: none; }
        
        .chip-info { font-weight: bold; margin-bottom: 8px; color: #FFF; font-size: 1.1em; }
        .chip-sub { font-size: 0.85em; color: #888; }
        
        .btn-group { display: flex; gap: 8px; margin-top: 15px; }
        .btn { background: #222; color: #00FF00; border: 1px solid #00FF00; padding: 12px; cursor: pointer; text-transform: uppercase; font-size: 0.9em; flex: 1; min-height: 45px; font-weight: bold; transition: all 0.1s; display: flex; align-items: center; justify-content: center; }
        .btn:hover:not(:disabled) { background: #00FF00; color: #000; }
        .btn:active:not(:disabled) { transform: scale(0.95); opacity: 0.7; }
        .btn:disabled { opacity: 0.5; cursor: not-allowed; border-color: #444; color: #888; }
        
        .btn-active { background: #FF0000; color: #FFF; border-color: #FF0000; }
        .btn-active:hover:not(:disabled) { background: #CC0000; }
        .btn-wait { background: #FFD600 !important; color: #000 !important; border-color: #FFD600 !important; }

        .actions { margin-bottom: 30px; display: flex; gap: 15px; }
        
        #modal-overlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.9); z-index: 999; display: none; align-items: center; justify-content: center; }
        #modal-content { background: #111; border: 2px solid #00FF00; padding: 30px; width: 400px; text-align: center; box-shadow: 0 0 50px rgba(0,255,0,0.2); }
        #modal-message { font-size: 1.4em; margin-bottom: 25px; line-height: 1.4; color: #FFF; }
        .btn-ok { background: #00FF00; color: #000; padding: 15px 40px; border: none; font-weight: bold; font-size: 1.1em; cursor: pointer; display: none; margin: 0 auto; text-transform: uppercase; }
        .loader { width: 50px; height: 50px; border: 5px solid #222; border-top: 5px solid #00FF00; border-radius: 50%; animation: spin 1s linear infinite; margin: 0 auto 20px; }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }

        table { width: 100%; border-collapse: collapse; margin-top: 20px; border: 1px solid #222; }
        th { text-align: left; padding: 15px; border-bottom: 2px solid #00FF00; background: #0a0a0a; }
        td { padding: 15px; border-bottom: 1px solid #222; }
        .sms-code { color: #FFF; background: #333; padding: 5px 12px; font-weight: bold; cursor: pointer; border: 1px solid #555; }
        .sms-code:hover { background: #00FF00; color: #000; }
    </style>
</head>
<body>
    <div id="modal-overlay">
        <div id="modal-content">
            <div id="modal-loader" class="loader"></div>
            <div id="modal-message">Ativando número...<br>Aguarde o sinal da rede.</div>
            <button class="btn-ok" id="btn-modal-ok" onclick="fecharModal()">OK! PEÇO O SMS</button>
        </div>
    </div>

    <div class="container">
        <h1>GSM HUB DASHBOARD</h1>
        
        <div class="grid-numeros" id="lista-numeros"></div>

        <div class="actions">
            <button class="btn" id="btn-watch-global" onclick="toggleWatchGlobal()" style="padding:15px 30px;">👁️ MONITORAR TODOS</button>
            <button class="btn" onclick="limparTela()" style="padding:15px 30px;">🗑️ LIMPAR TELA</button>
        </div>

        <table>
            <thead><tr><th>HORA</th><th>NÚMERO</th><th>SERVIÇO</th><th>CÓDIGO</th></tr></thead>
            <tbody id="tabela-corpo"></tbody>
        </table>
    </div>

    <script>
        var ativos = {};
        var watchAtivo = false;
        var bloqueios = {}; 
        var ativandoPorta = null; 
        var varreduraCompleta = false;

        function copiar(t) { navigator.clipboard.writeText(t); }

        function fecharModal() {
            document.getElementById('modal-overlay').style.display = 'none';
            ativandoPorta = null;
        }

        async function toggleMonitor(p, n, btn) {
            var isAtivo = ativos[p];

            if(!isAtivo) {
                ativandoPorta = p;
                document.getElementById('modal-overlay').style.display = 'flex';
                document.getElementById('modal-message').innerHTML = 'Ativando ' + n + '...<br><span style="color:#888; font-size:0.8em;">Configurando leitura de SMS.</span>';
                document.getElementById('modal-loader').style.display = 'block';
                document.getElementById('btn-modal-ok').style.display = 'none';
            }

            if(btn) {
                btn.innerText = '...';
                btn.className = 'btn btn-wait';
                btn.disabled = true;
            }
            
            bloqueios[p] = true;
            setTimeout(() => { delete bloqueios[p]; }, 5000);

            try {
                await fetch(isAtivo ? '/api/monitorar/stop' : '/api/monitorar/start', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({porta: p, numero: n})
                });
            } catch(e) { console.error(e); }
            
            setTimeout(atualizar, 1000);
        }

        async function toggleWatchGlobal() {
            var btn = document.getElementById('btn-watch-global');
            btn.innerText = '...';
            btn.className = 'btn btn-wait';
            btn.disabled = true;

            try {
                await fetch(watchAtivo ? '/api/watch/stop' : '/api/watch/start', {method: 'POST'});
            } catch(e) { console.error(e); }
            
            setTimeout(atualizar, 1500);
        }

        async function limparTela() { 
            if(confirm("Deseja limpar todos os códigos da tela?")) {
                await fetch('/api/limpar-tela', {method: 'POST'}); 
                setTimeout(atualizar, 500);
            }
        }

        async function atualizar() {
            try {
                const res = await fetch('/api/dados'); const d = await res.json();
                const resSt = await fetch('/api/monitorar/status'); const dSt = await resSt.json(); ativos = dSt.ativos || {};
                const resW = await fetch('/api/watch/status'); const dW = await resW.json(); watchAtivo = dW.ativo;

                // Verifica se a varredura terminou (não há strings de busca nos números)
                varreduraCompleta = d.numeros.every(m => !m.numero.includes('Buscando') && !m.numero.includes('Aguardando') && m.numero.length > 5);
                
                // Algum modem individual está ativo?
                const algumAtivo = Object.keys(ativos).length > 0;

                // Verifica se a porta que estava ativando finalmente subiu
                if(ativandoPorta && ativos[ativandoPorta]) {
                    // Pequeno delay extra para garantir que o modem registrou na torre (sync com o CMD)
                    setTimeout(() => {
                        if(ativandoPorta) {
                            document.getElementById('modal-message').innerHTML = '<span style="color:#00FF00; font-size:1.5em; font-weight:bold;">PRONTO!</span><br><br>O chip já registrou na rede.<br>Pode pedir o SMS agora.';
                            document.getElementById('modal-loader').style.display = 'none';
                            document.getElementById('btn-modal-ok').style.display = 'block';
                        }
                    }, 5000); 
                }

                const bW = document.getElementById('btn-watch-global');
                if(!bW.classList.contains('btn-wait')) {
                    bW.disabled = !varreduraCompleta;
                    if(watchAtivo) { bW.innerText = '⏹️ PARAR TODOS'; bW.className = 'btn btn-active'; }
                    else { bW.innerText = '👁️ MONITORAR TODOS'; bW.className = 'btn'; }
                }

                const grid = document.getElementById('lista-numeros');
                let hModems = '';
                d.numeros.forEach(m => {
                    const isM = ativos[m.porta];
                    const numPronto = !m.numero.includes('Buscando') && !m.numero.includes('Aguardando') && m.numero.length > 5;
                    
                    // Lógica de exclusividade: Se algum está ativo E este não é o ativo atual, desabilita o ON
                    const deveBloquearOn = (algumAtivo && !isM && !watchAtivo) || !numPronto;

                    if(!bloqueios[m.porta]) {
                        hModems += `
                            <div class="chip-box ${isM ? 'monitorando' : ''} ${!numPronto ? 'desabilitado' : ''}">
                                <div class="chip-sub">${m.porta}</div>
                                <div class="chip-info">${m.numero}</div>
                                <div style="font-size: 10px; color: #666; margin-bottom: 5px;">Clique em "on" para ativar o numero</div>
                                <div class="btn-group">
                                    <button class="btn" onclick="copiar('${m.numero}')" ${!numPronto ? 'disabled' : ''}>📋</button>
                                    <button class="btn ${isM ? 'btn-active' : ''}" 
                                            onclick="toggleMonitor('${m.porta}', '${m.numero}', this)"
                                            ${deveBloquearOn ? 'disabled' : ''}>
                                        ${isM ? 'OFF' : 'ON'}
                                    </button>
                                </div>
                            </div>`;
                    } else {
                        hModems += `
                            <div class="chip-box monitorando">
                                <div class="chip-sub">${m.porta}</div>
                                <div class="chip-info">${m.numero}</div>
                                <div class="btn-group">
                                    <button class="btn" disabled>📋</button>
                                    <button class="btn btn-wait" disabled>...</button>
                                </div>
                            </div>`;
                    }
                });
                if(hModems) grid.innerHTML = hModems;

                const tbody = document.getElementById('tabela-corpo');
                let hSms = '';
                if(d.codigos && d.codigos.length > 0) {
                    d.codigos.slice().reverse().forEach(s => {
                        hSms += `<tr><td>${s.timestamp}</td><td>${s.numero}</td><td>${s.servico}</td><td><span class="sms-code" onclick="copiar('${s.codigo}')">${s.codigo}</span></td></tr>`;
                    });
                    tbody.innerHTML = hSms;
                } else {
                    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; color:#444; padding:20px;">Aguardando novo SMS...</td></tr>';
                }
            } catch(e) {}
        }

        setInterval(atualizar, 2000); 
        atualizar();
    </script>
</body>
</html>
"""

@app.route('/')
@requires_auth
def index(): return render_template_string(TEMPLATE_HTML)

@app.route('/api/dados')
@requires_auth
def api_dados():
    from config import PREFIXO_CCID, STATUS_FALHAS
    modems_lista = []
    with state.lock:
        for porta, num in state.resultados.items():
            if num not in STATUS_FALHAS:
                if num.startswith(PREFIXO_CCID):
                    ccid_v, num_v = parsear_ccid(num)
                    num_display = num_v if num_v else f"CCID:...{ccid_v[-4:]}"
                else: num_display = num
                modems_lista.append({"porta": porta, "numero": num_display})
    
    with state.fila_lock:
        lista_sms = []
        for item in state.fila_codigos:
            item_limpo = dict(item)
            if item_limpo["numero"].startswith(PREFIXO_CCID):
                ccid_v, num_v = parsear_ccid(item_limpo["numero"])
                item_limpo["numero"] = num_v if num_v else f"CCID:...{ccid_v[-4:]}"
            lista_sms.append(item_limpo)
    return jsonify({"numeros": modems_lista, "codigos": lista_sms})

@app.route('/api/limpar-tela', methods=['POST'])
@requires_auth
def api_limpar_tela():
    with state.fila_lock: state.fila_codigos.clear()
    return jsonify({"ok": True})

@app.route('/api/monitorar/status')
@requires_auth
def api_status():
    with state.monitores_lock: return jsonify({"ativos": {p:info["numero"] for p,info in state.monitores_individuais.items()}})

@app.route('/api/watch/status')
@requires_auth
def api_watch_status(): return jsonify({"ativo": state.watch_global_ativo})

@app.route('/api/monitorar/start', methods=['POST'])
@requires_auth
def api_start():
    p, n = request.json.get('porta'), request.json.get('numero')
    with state.monitores_lock:
        if p not in state.monitores_individuais:
            from modems.monitor import thread_monitor_individual
            stop_evt = threading.Event()
            t = threading.Thread(target=thread_monitor_individual, args=(p, n, stop_evt), daemon=True)
            state.monitores_individuais[p] = {"thread":t, "stop":stop_evt, "numero":n}
            t.start()
    return jsonify({"ok": True})

@app.route('/api/monitorar/stop', methods=['POST'])
@requires_auth
def api_stop():
    p = request.json.get('porta')
    with state.monitores_lock:
        if p in state.monitores_individuais:
            state.monitores_individuais[p]["stop"].set()
    return jsonify({"ok": True})

@app.route('/api/watch/start', methods=['POST'])
@requires_auth
def api_watch_start():
    state.watch_global_ativo = True
    with state.lock:
        for p,n in state.resultados.items():
            if n not in ["Falha","Sem Chip"]:
                with state.monitores_lock:
                    if p not in state.monitores_individuais:
                        from modems.monitor import thread_monitor_individual
                        stop_evt = threading.Event()
                        t = threading.Thread(target=thread_monitor_individual, args=(p, n, stop_evt), daemon=True)
                        state.monitores_individuais[p] = {"thread":t, "stop":stop_evt, "numero":n}
                        t.start()
    return jsonify({"ok": True})

@app.route('/api/watch/stop', methods=['POST'])
@requires_auth
def api_watch_stop():
    state.watch_global_ativo = False
    with state.monitores_lock:
        for p in list(state.monitores_individuais.keys()):
            state.monitores_individuais[p]["stop"].set()
    return jsonify({"ok": True})

@app.route('/api/exportar-numeros')
@requires_auth
def api_exportar_numeros():
    from db.database import obter_todos_os_numeros
    numeros = obter_todos_os_numeros()
    return Response("\r\n".join(numeros), mimetype="text/plain", headers={"Content-disposition": "attachment; filename=lista_historico_numeros.txt"})

def iniciar_servidor_web():
    try:
        ngrok.set_auth_token(NGROK_AUTH_TOKEN)
        url = ngrok.connect(5000, domain=NGROK_DOMAIN).public_url
        print(f"  🌐 PAINEL EM: {url}")
    except: pass
    app.run(host='0.0.0.0', port=5000, use_reloader=False, threaded=True)

if __name__ == '__main__': iniciar_servidor_web()
