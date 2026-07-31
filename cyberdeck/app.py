"""CYBERDECK M8 — v0.1 backend.
Tablet = interface, laptop = compute. Serves a cyberpunk dashboard + live stats.
Run:  python app.py    (listens on 0.0.0.0:8080)
Tablet reaches it over USB via:  adb reverse tcp:8080 tcp:8080  ->  http://127.0.0.1:8080
"""
import asyncio, json, socket, time, pathlib
import psutil, httpx
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse

ROOT = pathlib.Path(__file__).parent
CONFIG = json.loads((ROOT / "config.json").read_text())
app = FastAPI()

# ponytail: 3s cache on service checks so N websocket clients don't hammer endpoints
_svc_cache = {"t": 0.0, "data": []}


async def check_services():
    if time.time() - _svc_cache["t"] < 3 and _svc_cache["data"]:
        return _svc_cache["data"]
    out = []
    async with httpx.AsyncClient(timeout=2.0, verify=False) as client:
        for s in CONFIG["services"]:
            status = "UNCONFIGURED"
            if s["type"] == "http" and s.get("url"):
                try:
                    r = await client.get(s["url"])
                    status = "ONLINE" if r.status_code < 500 else "DEGRADED"
                except Exception:
                    status = "OFFLINE"
            elif s["type"] == "tcp" and s.get("host"):
                status = await asyncio.get_event_loop().run_in_executor(None, _tcp_probe, s["host"], s["port"])
            out.append({"name": s["name"], "status": status, "note": s.get("note", "")})
    _svc_cache.update(t=time.time(), data=out)
    return out


def _tcp_probe(host, port):
    try:
        with socket.create_connection((host, int(port)), timeout=2):
            return "ONLINE"
    except Exception:
        return "OFFLINE"


def system_stats():
    vm = psutil.virtual_memory()
    bat = psutil.sensors_battery()
    return {
        "cpu": psutil.cpu_percent(interval=None),
        "mem_used_gb": round(vm.used / 1024**3, 1),
        "mem_total_gb": round(vm.total / 1024**3, 1),
        "mem_pct": vm.percent,
        "battery": round(bat.percent) if bat else None,
        "ts": time.strftime("%H:%M:%S"),
    }


@app.get("/api/status")
async def status():
    return {"system": system_stats(), "services": await check_services()}


@app.websocket("/ws")
async def ws(sock: WebSocket):
    await sock.accept()
    try:
        while True:
            await sock.send_json({"system": system_stats(), "services": await check_services()})
            await asyncio.sleep(2)
    except WebSocketDisconnect:
        pass


@app.get("/api/github")
async def github_feed():
    async with httpx.AsyncClient() as client:
        try:
            r = await client.get("https://api.github.com/repos/microsoft/terminal/commits?per_page=5", headers={"User-Agent": "Cyberdeck"})
            return {"status": "ok", "data": r.json()}
        except Exception as e:
            return {"status": "error", "message": str(e)}


@app.post("/api/deploy")
async def trigger_deploy():
    script_path = ROOT / "scripts" / "deploy.bat"
    if not script_path.exists():
        return {"status": "error", "message": "Deploy script not found."}
    
    proc = await asyncio.create_subprocess_shell(
        str(script_path),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE
    )
    stdout, stderr = await proc.communicate()
    return {"status": "ok", "output": stdout.decode(errors='replace') + stderr.decode(errors='replace')}


@app.websocket("/ws/terminal")
async def terminal_ws(sock: WebSocket):
    await sock.accept()
    try:
        while True:
            cmd = await sock.receive_text()
            if cmd.strip() == "":
                continue
            proc = await asyncio.create_subprocess_shell(
                cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=str(ROOT)
            )
            stdout, stderr = await proc.communicate()
            out = stdout.decode(errors='replace') + stderr.decode(errors='replace')
            await sock.send_text(out if out else "\n")
    except WebSocketDisconnect:
        pass


@app.get("/")
async def index():
    return HTMLResponse((ROOT / "index.html").read_text(encoding="utf-8"))


# --- PHASE 3 ENDPOINTS ---

@app.post("/api/chat")
async def ai_chat(request: dict):
    prompt = request.get("prompt", "")
    if not prompt:
        return {"status": "error", "message": "No prompt provided."}
    
    async with httpx.AsyncClient() as client:
        try:
            payload = {"model": "llama3", "prompt": prompt, "stream": False}
            r = await client.post("http://127.0.0.1:11434/api/generate", json=payload, timeout=30.0)
            data = r.json()
            return {"status": "ok", "response": data.get("response", "")}
        except Exception as e:
            return {"status": "error", "message": f"Ollama connection failed (is it running?): {e}"}

@app.get("/api/projects")
async def get_projects():
    p_file = ROOT / "projects.json"
    if not p_file.exists():
        p_file.write_text(json.dumps([
            {"name": "CYBERDECK M8", "status": "ACTIVE", "desc": "Phase 3 implementation in progress"},
            {"name": "AWS EDGE NODE", "status": "ONLINE", "desc": "Deployed successfully"},
            {"name": "NEURAL NET v2", "status": "PAUSED", "desc": "Waiting for compute allocation"}
        ], indent=2))
    return {"status": "ok", "data": json.loads(p_file.read_text())}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8080, log_level="warning")
