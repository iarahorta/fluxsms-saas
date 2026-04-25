#!/usr/bin/env python3
"""
Diagnostico rapido do fluxo FluxSMS Desktop -> Partner API.

Uso rapido:
  python scripts/diag_partner_worker.py --api-key "SUA_CHAVE"

Opcional:
  --base-url https://fluxsms.com.br
  --no-hwid
  --output diag_fluxsms.json
"""

from __future__ import annotations

import argparse
import hashlib
import json
import platform
import sys
import time
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

try:
    import requests
except ImportError:
    print("ERRO: modulo 'requests' nao encontrado. Rode: pip install requests")
    sys.exit(1)


def iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def short(s: Any, limit: int = 240) -> str:
    txt = str(s)
    return txt if len(txt) <= limit else txt[:limit] + "...(truncado)"


def read_machine_guid_windows() -> Optional[str]:
    if platform.system().lower() != "windows":
        return None
    try:
        import winreg  # type: ignore
    except Exception:
        return None
    keys = [
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Cryptography"),
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Microsoft\Cryptography"),
    ]
    for root, path in keys:
        try:
            with winreg.OpenKey(root, path) as key:
                value, _ = winreg.QueryValueEx(key, "MachineGuid")
                if value:
                    return str(value).strip()
        except Exception:
            continue
    return None


def build_flux_hwid() -> Optional[str]:
    guid = read_machine_guid_windows()
    if not guid:
        return None
    # Replica o app Electron:
    # machineIdSync() (node-machine-id) devolve hash hex da MachineGuid no Windows.
    # Depois o app faz sha256("fluxsms|desktop|<machineIdSync()>").
    machine_id_sync_like = hashlib.sha256(guid.encode("utf-8")).hexdigest()
    raw = f"fluxsms|desktop|{machine_id_sync_like}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def list_com_ports() -> List[str]:
    try:
        from serial.tools import list_ports  # type: ignore
    except Exception:
        return []
    ports = []
    for p in list_ports.comports():
        name = str(getattr(p, "device", "")).strip().upper()
        if name.startswith("COM"):
            ports.append(name)
    return sorted(set(ports), key=lambda x: int("".join(ch for ch in x if ch.isdigit()) or "0"))


@dataclass
class StepResult:
    name: str
    method: str
    url: str
    status: Optional[int]
    ok: bool
    elapsed_ms: int
    response_preview: str
    error: Optional[str] = None


def request_json(
    session: requests.Session,
    method: str,
    url: str,
    headers: Dict[str, str],
    timeout_s: int,
    params: Optional[Dict[str, Any]] = None,
    body: Optional[Dict[str, Any]] = None,
) -> Tuple[StepResult, Optional[Dict[str, Any]]]:
    t0 = time.time()
    try:
        resp = session.request(
            method=method,
            url=url,
            headers=headers,
            params=params,
            json=body,
            timeout=timeout_s,
        )
        elapsed_ms = int((time.time() - t0) * 1000)
        data: Optional[Dict[str, Any]] = None
        preview = resp.text
        try:
            data = resp.json()
            preview = short(json.dumps(data, ensure_ascii=False))
        except Exception:
            preview = short(resp.text)
        ok = 200 <= resp.status_code < 300
        return (
            StepResult(
                name="",
                method=method,
                url=url,
                status=resp.status_code,
                ok=ok,
                elapsed_ms=elapsed_ms,
                response_preview=preview,
                error=None if ok else f"HTTP {resp.status_code}",
            ),
            data,
        )
    except Exception as exc:
        elapsed_ms = int((time.time() - t0) * 1000)
        return (
            StepResult(
                name="",
                method=method,
                url=url,
                status=None,
                ok=False,
                elapsed_ms=elapsed_ms,
                response_preview="",
                error=short(exc),
            ),
            None,
        )


def print_step(step: StepResult) -> None:
    status = step.status if step.status is not None else "ERR"
    mark = "OK " if step.ok else "FALHA"
    print(f"[{mark}] {step.name}: {step.method} {step.url} -> {status} ({step.elapsed_ms} ms)")
    if step.error:
        print(f"       erro: {step.error}")
    if step.response_preview:
        print(f"       resp: {step.response_preview}")


def diagnose_hint(steps: List[StepResult], chips_count: int, ports: List[str]) -> str:
    by_name = {s.name: s for s in steps}
    health = by_name.get("health")
    bootstrap = by_name.get("bootstrap")
    chips = by_name.get("worker_chips")

    if health and not health.ok:
        if health.status in (401, 403):
            return "Auth falhou (API key/HWID). Verifique chave e vinculacao de HWID."
        return "API de health falhou. Verifique URL base, internet ou backend."
    if bootstrap and not bootstrap.ok:
        return "Bootstrap do worker falhou. Verifique partner/polo no backend."
    if chips and chips.ok and chips_count == 0 and ports:
        return "PC ve portas COM, mas backend nao retornou chips. Possivel falha no sync /worker/sync ou no core."
    if chips and chips.ok and chips_count > 0:
        return "Backend retorna chips. Se tabela local segue OFF, problema e no app local/refresh."
    return "Diagnostico inconclusivo. Envie o JSON gerado para analise detalhada."


def main() -> int:
    parser = argparse.ArgumentParser(description="Diagnostico FluxSMS Partner Worker")
    parser.add_argument("--api-key", required=True, help="Partner API key")
    parser.add_argument("--base-url", default="https://fluxsms.com.br", help="Base URL da API")
    parser.add_argument("--timeout", type=int, default=20, help="Timeout HTTP em segundos")
    parser.add_argument("--no-hwid", action="store_true", help="Nao enviar X-Flux-Hwid")
    parser.add_argument("--output", default="diag_fluxsms.json", help="Arquivo de saida JSON")
    args = parser.parse_args()

    base = args.base_url.rstrip("/")
    api_key = args.api_key.strip()
    hwid = None if args.no_hwid else build_flux_hwid()
    ports = list_com_ports()

    print("=== FluxSMS Diagnostico Partner Worker ===")
    print(f"timestamp: {iso_now()}")
    print(f"python: {sys.version.split()[0]}")
    print(f"os: {platform.platform()}")
    print(f"base_url: {base}")
    print(f"ports_detectadas: {ports if ports else 'nenhuma'}")
    print(f"hwid_enviado: {'sim' if hwid else 'nao'}")
    print("")

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    if hwid:
        headers["X-Flux-Hwid"] = hwid

    session = requests.Session()
    steps: List[StepResult] = []
    raw: Dict[str, Any] = {"meta": {}, "steps": [], "ports": ports}

    endpoints = [
        ("health", "GET", f"{base}/partner-api/health", None, None),
        ("bootstrap", "GET", f"{base}/partner-api/worker/bootstrap", None, None),
        ("worker_chips", "GET", f"{base}/partner-api/worker/chips", None, None),
        ("worker_activations", "GET", f"{base}/partner-api/worker/activations", None, None),
    ]

    chips_count = 0
    for name, method, url, params, body in endpoints:
        step, data = request_json(session, method, url, headers, args.timeout, params=params, body=body)
        step.name = name
        steps.append(step)
        payload = {"name": name, **asdict(step)}
        if isinstance(data, dict):
            payload["json"] = data
            if name == "worker_chips":
                chips_count = len(data.get("chips") or [])
        raw["steps"].append(payload)
        print_step(step)

    for p in ports[:20]:
        step, data = request_json(
            session,
            "GET",
            f"{base}/partner-api/worker/chip-activations",
            headers,
            args.timeout,
            params={"porta": p},
            body=None,
        )
        step.name = f"chip_activations[{p}]"
        steps.append(step)
        payload = {"name": step.name, **asdict(step)}
        if isinstance(data, dict):
            payload["json"] = data
        raw["steps"].append(payload)
        print_step(step)

    hint = diagnose_hint(steps, chips_count, ports)
    print("\nResumo provavel:")
    print(f"- {hint}")

    raw["meta"] = {
        "timestamp": iso_now(),
        "base_url": base,
        "python": sys.version,
        "platform": platform.platform(),
        "ports_detectadas": ports,
        "hwid_enviado": bool(hwid),
        "hint": hint,
    }

    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(raw, f, ensure_ascii=False, indent=2)
    print(f"\nRelatorio salvo em: {args.output}")
    print("Envie esse arquivo para eu analisar exatamente onde quebra.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
