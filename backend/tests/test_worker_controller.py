import sys
import threading
import uuid

import httpx
import pytest

from app.worker_controller import WorkerProcessManager, create_controller_server
from app.worker_lock import WorkerSingleInstanceLock


def _start_test_controller(tmp_path, *, lock_name: str):
    # Lightweight dummy worker that acquires the same single-instance lock and waits
    dummy_script = tmp_path / "dummy_worker.py"
    dummy_script.write_text(
        "import os, signal, sys, time\n"
        "sys.path.insert(0, os.getcwd())\n"
        "from app.worker_lock import WorkerSingleInstanceLock\n"
        "lock = WorkerSingleInstanceLock(os.environ['WORKER_LOCK_NAME'])\n"
        "if not lock.acquire(): sys.exit(0)\n"
        "stop = False\n"
        "def h(s, f):\n"
        "    global stop\n"
        "    stop = True\n"
        "signal.signal(signal.SIGTERM, h)\n"
        "signal.signal(signal.SIGINT, h)\n"
        "if hasattr(signal, 'SIGBREAK'): signal.signal(signal.SIGBREAK, h)\n"
        "try:\n"
        "    while not stop: time.sleep(0.05)\n"
        "finally:\n"
        "    lock.release()\n",
        encoding="utf-8",
    )
    mgr = WorkerProcessManager(
        worker_cmd=[sys.executable, str(dummy_script)],
        lock_name=lock_name,
        log_file=tmp_path / "worker.log",
    )
    token = "test-controller-pairing-token-123456"
    server = create_controller_server(
        host="127.0.0.1",
        port=0,
        manager=mgr,
        pairing_token=token,
    )
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, mgr, f"http://127.0.0.1:{port}", token


def test_controller_rejects_non_loopback_bind():
    with pytest.raises(ValueError, match="127.0.0.1"):
        create_controller_server(host="0.0.0.0", port=0)


def test_controller_origin_csrf_and_auth_enforcement(tmp_path):
    lock_name = f"Local\\ScribaSheetCtrlAuth_{uuid.uuid4().hex}"
    server, mgr, base_url, token = _start_test_controller(tmp_path, lock_name=lock_name)
    try:
        # Disallowed origin rejected
        r_bad_origin = httpx.get(f"{base_url}/health", headers={"Origin": "https://evil.example.com"})
        assert r_bad_origin.status_code == 403

        # Allowed Vercel origin + Private Network Access preflight
        r_opt = httpx.options(
            f"{base_url}/worker/start",
            headers={
                "Origin": "https://scribasheet.vercel.app",
                "Access-Control-Request-Private-Network": "true",
            },
        )
        assert r_opt.status_code == 204
        assert r_opt.headers.get("Access-Control-Allow-Origin") == "https://scribasheet.vercel.app"
        assert r_opt.headers.get("Access-Control-Allow-Private-Network") == "true"

        # Missing pairing token rejected
        r_unauth = httpx.get(f"{base_url}/status", headers={"Origin": "http://localhost:5173"})
        assert r_unauth.status_code == 401

        # Missing CSRF header rejected on POST
        r_no_csrf = httpx.post(
            f"{base_url}/worker/start",
            headers={"Origin": "http://localhost:5173", "X-Controller-Token": token},
        )
        assert r_no_csrf.status_code == 403
    finally:
        mgr.stop()
        server.shutdown()
        server.server_close()


def test_controller_start_status_restart_stop_and_single_instance(tmp_path):
    lock_name = f"Local\\ScribaSheetCtrlLife_{uuid.uuid4().hex}"
    server, mgr, base_url, token = _start_test_controller(tmp_path, lock_name=lock_name)
    headers = {
        "Origin": "http://localhost:5173",
        "X-Controller-Token": token,
        "X-Requested-With": "ScribaSheet",
        "Content-Type": "application/json",
    }
    try:
        s0 = httpx.get(f"{base_url}/status", headers=headers).json()
        assert s0["worker_running"] is False

        r_start = httpx.post(f"{base_url}/worker/start", headers=headers, content="{}")
        assert r_start.status_code == 200
        d_start = r_start.json()
        assert d_start["worker_running"] is True
        first_pid = d_start["pid"]
        assert first_pid is not None

        # Restart produces a new PID
        r_restart = httpx.post(f"{base_url}/worker/restart", headers=headers, content="{}")
        assert r_restart.status_code == 200
        d_restart = r_restart.json()
        assert d_restart["worker_running"] is True
        assert d_restart["pid"] is not None

        # Stop cleanly
        r_stop = httpx.post(f"{base_url}/worker/stop", headers=headers, content="{}")
        assert r_stop.status_code == 200
        assert r_stop.json()["worker_running"] is False

        # External lock holder blocks controller start with 409
        ext_lock = WorkerSingleInstanceLock(lock_name=lock_name)
        assert ext_lock.acquire() is True
        try:
            # Note: same-process Windows mutex is thread-reentrant; test from another thread
            import concurrent.futures

            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as ex:
                fut = ex.submit(httpx.post, f"{base_url}/worker/start", headers=headers, content="{}")
                r_conflict = fut.result(timeout=5)
                assert r_conflict.status_code == 409
        finally:
            ext_lock.release()
    finally:
        mgr.stop()
        server.shutdown()
        server.server_close()
