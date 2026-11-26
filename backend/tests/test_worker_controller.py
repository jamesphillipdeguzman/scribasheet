import sys
import threading
import uuid

import httpx
import pytest

from app.worker_controller import (
    WorkerProcessManager,
    create_controller_server,
    is_scribasheet_worker_process,
)
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


def test_is_scribasheet_worker_process_validates_repo_and_rejects_unrelated_python(tmp_path):
    repo_root = tmp_path / "scribasheet"
    backend_dir = repo_root / "backend"
    other_repo = tmp_path / "other_project"
    repo_root.mkdir()
    backend_dir.mkdir()
    other_repo.mkdir()

    py_exe = str(backend_dir / ".venv" / "Scripts" / "python.exe")

    # Valid ScribaSheet worker in this repo
    assert is_scribasheet_worker_process(
        pid=2222,
        exe=py_exe,
        cmdline=[py_exe, "-m", "app.worker_agent"],
        cwd=str(backend_dir),
        repo_root=repo_root,
        self_pid=1000,
    ) is True

    # Unrelated Python script must be rejected
    assert is_scribasheet_worker_process(
        pid=2223,
        exe=py_exe,
        cmdline=[py_exe, "-m", "http.server", "8000"],
        cwd=str(backend_dir),
        repo_root=repo_root,
        self_pid=1000,
    ) is False

    # Worker belonging to another repo must be rejected
    assert is_scribasheet_worker_process(
        pid=2224,
        exe=str(other_repo / ".venv" / "Scripts" / "python.exe"),
        cmdline=["python.exe", "-m", "app.worker_agent"],
        cwd=str(other_repo / "backend"),
        repo_root=repo_root,
        self_pid=1000,
    ) is False

    # Self PID and controller-managed PID must be rejected
    assert is_scribasheet_worker_process(
        pid=1000,
        exe=py_exe,
        cmdline=[py_exe, "-m", "app.worker_agent"],
        cwd=str(backend_dir),
        repo_root=repo_root,
        self_pid=1000,
    ) is False


def test_controller_discovers_stops_and_restarts_external_worker(tmp_path, monkeypatch):
    import concurrent.futures
    import subprocess

    lock_name = f"Local\\ScribaSheetCtrlExt_{uuid.uuid4().hex}"
    server, mgr, base_url, token = _start_test_controller(tmp_path, lock_name=lock_name)
    headers = {
        "Origin": "http://localhost:5173",
        "X-Controller-Token": token,
        "X-Requested-With": "ScribaSheet",
        "Content-Type": "application/json",
    }

    # Spawn an actual external Python process that holds the lock
    ext_script = tmp_path / "ext_worker_sim.py"
    ext_script.write_text(
        "import os, signal, sys, time\n"
        "sys.path.insert(0, os.getcwd())\n"
        "from app.worker_lock import WorkerSingleInstanceLock\n"
        "lock = WorkerSingleInstanceLock(os.environ['WORKER_LOCK_NAME'])\n"
        "if not lock.acquire(): sys.exit(1)\n"
        "stop = False\n"
        "def h(s, f):\n"
        "    global stop\n"
        "    stop = True\n"
        "signal.signal(signal.SIGTERM, h)\n"
        "try:\n"
        "    while not stop: time.sleep(0.05)\n"
        "finally:\n"
        "    lock.release()\n",
        encoding="utf-8",
    )
    import os

    env = dict(os.environ)
    env["WORKER_LOCK_NAME"] = lock_name
    ext_proc = subprocess.Popen([sys.executable, str(ext_script)], cwd=str(mgr.backend_dir), env=env)
    try:
        # Wait briefly for external process to acquire lock
        import time

        for _ in range(20):
            if mgr._is_external_lock_held():
                break
            time.sleep(0.05)

        monkeypatch.setattr(mgr, "_discover_external_worker_pids", lambda: [ext_proc.pid] if ext_proc.poll() is None else [])
        monkeypatch.setattr(mgr, "_validate_pid_is_worker", lambda pid: pid == ext_proc.pid and ext_proc.poll() is None)

        s_ext = httpx.get(f"{base_url}/status", headers=headers).json()
        assert s_ext["worker_running"] is True
        assert s_ext["managed_by_controller"] is False
        assert s_ext["external_worker_detected"] is True
        assert s_ext["external_manageable"] is True
        assert s_ext["pid"] == ext_proc.pid

        # Restart stops external process and launches a fresh controller-managed worker
        r_restart = httpx.post(f"{base_url}/worker/restart", headers=headers, content="{}")
        assert r_restart.status_code == 200
        d_restart = r_restart.json()
        assert ext_proc.poll() is not None
        assert d_restart["worker_running"] is True
        assert d_restart["managed_by_controller"] is True
        assert d_restart["pid"] is not None
        assert d_restart["pid"] != ext_proc.pid

        # Concurrent start requests while running never spawn duplicates
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as ex:
            results = [
                ex.submit(httpx.post, f"{base_url}/worker/start", headers=headers, content="{}").result(timeout=5)
                for _ in range(3)
            ]
        pids = {r.json()["pid"] for r in results}
        assert pids == {d_restart["pid"]}

        # Stop cleanly
        r_stop = httpx.post(f"{base_url}/worker/stop", headers=headers, content="{}")
        assert r_stop.status_code == 200
        assert r_stop.json()["worker_running"] is False
    finally:
        if ext_proc.poll() is None:
            ext_proc.kill()
        mgr.stop()
        server.shutdown()
        server.server_close()


def test_controller_refuses_pid_reuse_and_reports_permission_errors(tmp_path, monkeypatch):
    mgr = WorkerProcessManager(
        repo_root=tmp_path,
        lock_name=f"Local\\ScribaSheetPerm_{uuid.uuid4().hex}",
        log_file=tmp_path / "worker.log",
    )
    monkeypatch.setattr(mgr, "_validate_pid_is_worker", lambda pid: False)
    ok, msg = mgr._terminate_external_pid(99999)
    assert ok is False
    assert "Refused to terminate PID 99999" in msg

    # Simulate AccessDenied during termination
    import psutil

    class _DeniedProc:
        def __init__(self, pid):
            self.pid = pid

        def terminate(self):
            raise psutil.AccessDenied(self.pid)

    monkeypatch.setattr(mgr, "_validate_pid_is_worker", lambda pid: True)
    monkeypatch.setattr(psutil, "Process", _DeniedProc)
    ok2, msg2 = mgr._terminate_external_pid(88888)
    assert ok2 is False
    assert "Permission denied" in msg2


def test_controller_cors_pna_headers_across_endpoints_and_errors(tmp_path):
    token = "test-pna-token"
    mgr = WorkerProcessManager(
        repo_root=tmp_path,
        lock_name=f"Local\\ScribaSheetPna_{uuid.uuid4().hex}",
        log_file=tmp_path / "worker.log",
    )
    server = create_controller_server(
        host="127.0.0.1",
        port=0,
        manager=mgr,
        pairing_token=token,
    )
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base_url = f"http://127.0.0.1:{port}"
    allowed_origins = [
        "https://scribasheet.vercel.app",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:3000",
    ]
    try:
        for origin in allowed_origins:
            # Preflight across /health, /status, /worker/start, and /start alias
            for path, req_method in [
                ("/health", "GET"),
                ("/status", "GET"),
                ("/worker/start", "POST"),
                ("/start", "POST"),
            ]:
                r_opt = httpx.options(
                    f"{base_url}{path}",
                    headers={
                        "Origin": origin,
                        "Access-Control-Request-Method": req_method,
                        "Access-Control-Request-Headers": "Content-Type, X-Controller-Token, X-Requested-With",
                        "Access-Control-Request-Private-Network": "true",
                    },
                )
                assert r_opt.status_code == 204
                assert r_opt.headers.get("Access-Control-Allow-Origin") == origin
                assert r_opt.headers.get("Access-Control-Allow-Private-Network") == "true"
                assert "X-Controller-Token" in r_opt.headers.get("Access-Control-Allow-Headers", "")
                vary = r_opt.headers.get("Vary", "")
                assert "Origin" in vary
                assert "Access-Control-Request-Private-Network" in vary

            # Actual GET /health includes CORS + PNA headers and query normalization
            r_health = httpx.get(f"{base_url}/health?t=1", headers={"Origin": origin})
            assert r_health.status_code == 200
            assert r_health.headers.get("Access-Control-Allow-Origin") == origin
            assert r_health.headers.get("Access-Control-Allow-Private-Network") == "true"
            assert "Origin" in r_health.headers.get("Vary", "")

            # Error responses (401 on /status, 404 on unknown) still return validated CORS + PNA headers
            r_401 = httpx.get(f"{base_url}/status", headers={"Origin": origin})
            assert r_401.status_code == 401
            assert r_401.headers.get("Access-Control-Allow-Origin") == origin
            assert r_401.headers.get("Access-Control-Allow-Private-Network") == "true"

            r_404 = httpx.get(f"{base_url}/does-not-exist", headers={"Origin": origin})
            assert r_404.status_code == 404
            assert r_404.headers.get("Access-Control-Allow-Origin") == origin
            assert r_404.headers.get("Access-Control-Allow-Private-Network") == "true"

        # Disallowed origin must be rejected and never receive ACAO / PNA allow headers or wildcard *
        r_bad_opt = httpx.options(
            f"{base_url}/health",
            headers={
                "Origin": "https://evil.example",
                "Access-Control-Request-Private-Network": "true",
            },
        )
        assert r_bad_opt.status_code == 403
        assert "Access-Control-Allow-Origin" not in r_bad_opt.headers
        assert "Access-Control-Allow-Private-Network" not in r_bad_opt.headers

        r_bad_get = httpx.get(f"{base_url}/health", headers={"Origin": "https://evil.example"})
        assert r_bad_get.status_code == 403
        assert "Access-Control-Allow-Origin" not in r_bad_get.headers
        assert "Access-Control-Allow-Private-Network" not in r_bad_get.headers
    finally:
        server.shutdown()
        server.server_close()
