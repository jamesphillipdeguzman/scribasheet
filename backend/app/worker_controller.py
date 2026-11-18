"""
Lightweight local Windows Worker Controller for ScribaSheet.

Binds exclusively to 127.0.0.1, requires strict Origin validation, CSRF headers,
and a locally generated pairing token, and manages ONLY the fixed command:
    backend\\.venv\\Scripts\\python.exe -m app.worker_agent

Does NOT import ML models and never permits arbitrary command execution.
"""

from __future__ import annotations

import hmac
import json
import logging
import os
import re
import secrets
import signal
import subprocess
import sys
import threading
import time
from collections import deque
from datetime import UTC, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from app.worker_lock import WorkerSingleInstanceLock

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("scribasheet.worker_controller")

DEFAULT_CONTROLLER_HOST = "127.0.0.1"
DEFAULT_CONTROLLER_PORT = 47832
MAX_LOG_BYTES = 5 * 1024 * 1024

DEFAULT_ALLOWED_ORIGINS = {
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:4173",
    "http://127.0.0.1:4173",
    "https://scribasheet.vercel.app",
}
VERCEL_PREVIEW_ORIGIN_RE = re.compile(r"^https://scribasheet(-[a-z0-9-]+)?\.vercel\.app$")
SECRET_REDACT_RE = re.compile(r"(WORKER_API_TOKEN|Bearer\s+[A-Za-z0-9._-]+|X-Controller-Token:\s*\S+)", re.IGNORECASE)


def resolve_repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def resolve_worker_python(repo_root: Path) -> Path:
    venv_python = repo_root / "backend" / ".venv" / "Scripts" / "python.exe"
    if venv_python.exists():
        return venv_python
    return Path(sys.executable)


def load_or_create_pairing_token(token_path: Path) -> str:
    token_path.parent.mkdir(parents=True, exist_ok=True)
    if token_path.exists():
        existing = token_path.read_text(encoding="utf-8").strip()
        if len(existing) >= 24:
            return existing
    token = secrets.token_urlsafe(32)
    token_path.write_text(token, encoding="utf-8")
    return token


def is_origin_allowed(origin: str | None, extra_origins: set[str] | None = None) -> bool:
    if not origin:
        return False
    cleaned = origin.strip().rstrip("/")
    allowed = set(DEFAULT_ALLOWED_ORIGINS)
    env_extra = os.environ.get("CONTROLLER_ALLOWED_ORIGINS", "")
    if env_extra:
        allowed.update(o.strip().rstrip("/") for o in env_extra.split(",") if o.strip())
    if extra_origins:
        allowed.update(o.strip().rstrip("/") for o in extra_origins if o.strip())
    if cleaned in allowed:
        return True
    return bool(VERCEL_PREVIEW_ORIGIN_RE.match(cleaned))


def sanitize_log_line(line: str) -> str:
    return SECRET_REDACT_RE.sub("[REDACTED]", line.rstrip("\r\n"))


def _load_backend_env(backend_dir: Path) -> dict[str, str]:
    env = dict(os.environ)
    env["PYTHONUNBUFFERED"] = "1"
    for name in (".env", "worker.env"):
        path = backend_dir / name
        if not path.exists():
            continue
        for raw in path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, val = line.split("=", 1)
            key = key.strip()
            val = val.strip().strip('"').strip("'")
            if key and not env.get(key):
                env[key] = val
    return env


def _is_path_within(candidate: str | None, root: Path) -> bool:
    if not candidate:
        return False
    try:
        cand_resolved = Path(candidate).resolve()
        root_resolved = root.resolve()
        return cand_resolved == root_resolved or root_resolved in cand_resolved.parents
    except Exception:
        return False


def is_scribasheet_worker_process(
    *,
    pid: int,
    exe: str | None,
    cmdline: list[str] | None,
    cwd: str | None,
    repo_root: Path,
    self_pid: int | None = None,
    managed_pid: int | None = None,
) -> bool:
    """Validate that a process is a ScribaSheet worker_agent.py belonging to this repo."""
    if pid <= 0 or pid == (self_pid or os.getpid()) or (managed_pid is not None and pid == managed_pid):
        return False
    if not cmdline:
        return False
    exe_name = Path(exe).name.lower() if exe else Path(cmdline[0]).name.lower()
    if "python" not in exe_name:
        return False

    has_worker_module = False
    for idx, arg in enumerate(cmdline):
        if arg == "-m" and idx + 1 < len(cmdline) and cmdline[idx + 1] == "app.worker_agent":
            has_worker_module = True
            break
        if "app.worker_agent" in arg or arg.replace("\\", "/").endswith("app/worker_agent.py"):
            has_worker_module = True
            break
    if not has_worker_module:
        return False

    return _is_path_within(cwd, repo_root) or _is_path_within(exe, repo_root)


class WorkerProcessManager:
    """Manages the fixed local worker subprocess with single-instance safety."""

    def __init__(
        self,
        *,
        repo_root: Path | None = None,
        worker_cmd: list[str] | None = None,
        lock_name: str | None = None,
        log_file: Path | None = None,
    ) -> None:
        self.repo_root = repo_root or resolve_repo_root()
        self.backend_dir = self.repo_root / "backend"
        self.logs_dir = self.repo_root / "logs"
        self.log_file = log_file or (self.logs_dir / "worker.log")
        self.lock_name = lock_name or os.environ.get("WORKER_LOCK_NAME", "Local\\ScribaSheetTranscriptionWorker")
        self._worker_cmd = worker_cmd
        self._lock = threading.RLock()
        self._proc: subprocess.Popen[Any] | None = None
        self._log_handle: Any = None
        self._started_at: str | None = None
        self._last_exit_code: int | None = None
        self._last_error: str | None = None

    def _get_worker_cmd(self) -> list[str]:
        if self._worker_cmd is not None:
            return list(self._worker_cmd)
        py = resolve_worker_python(self.repo_root)
        return [str(py), "-m", "app.worker_agent"]

    def _rotate_log_if_needed(self) -> None:
        self.log_file.parent.mkdir(parents=True, exist_ok=True)
        if self.log_file.exists() and self.log_file.stat().st_size > MAX_LOG_BYTES:
            backup = self.log_file.with_name(f"{self.log_file.name}.1")
            if backup.exists():
                backup.unlink()
            self.log_file.replace(backup)

    def _reap_if_exited(self) -> None:
        if self._proc is None:
            return
        code = self._proc.poll()
        if code is not None:
            self._last_exit_code = code
            if code != 0 and not self._last_error:
                self._last_error = f"Worker exited with code {code}."
            self._proc = None
            self._started_at = None
            if self._log_handle is not None:
                try:
                    self._log_handle.close()
                except Exception:
                    pass
                self._log_handle = None

    def _is_external_lock_held(self) -> bool:
        probe = WorkerSingleInstanceLock(lock_name=self.lock_name)
        if probe.acquire():
            probe.release()
            return False
        return True

    def _discover_external_worker_pids(self) -> list[int]:
        """Discover validated external app.worker_agent processes for this repo."""
        managed_pid = self._proc.pid if self._proc is not None and self._proc.poll() is None else None
        discovered: list[int] = []
        try:
            import psutil  # type: ignore

            for proc in psutil.process_iter(["pid", "exe", "cmdline", "cwd"]):
                try:
                    info = proc.info
                    pid = int(info.get("pid") or 0)
                    if is_scribasheet_worker_process(
                        pid=pid,
                        exe=info.get("exe"),
                        cmdline=info.get("cmdline"),
                        cwd=info.get("cwd"),
                        repo_root=self.repo_root,
                        managed_pid=managed_pid,
                    ):
                        discovered.append(pid)
                except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
                    continue
        except ImportError:
            if sys.platform == "win32":
                try:
                    ps_cmd = (
                        "Get-CimInstance Win32_Process -Filter \"Name LIKE 'python%'\" | "
                        "Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress"
                    )
                    res = subprocess.run(
                        ["powershell.exe", "-NoProfile", "-Command", ps_cmd],
                        capture_output=True,
                        text=True,
                        timeout=5,
                        check=False,
                    )
                    if res.returncode == 0 and res.stdout.strip():
                        rows = json.loads(res.stdout)
                        if isinstance(rows, dict):
                            rows = [rows]
                        for row in rows:
                            pid = int(row.get("ProcessId") or 0)
                            cmdline_str = str(row.get("CommandLine") or "")
                            exe = row.get("ExecutablePath")
                            if is_scribasheet_worker_process(
                                pid=pid,
                                exe=exe,
                                cmdline=cmdline_str.split(),
                                cwd=None,
                                repo_root=self.repo_root,
                                managed_pid=managed_pid,
                            ):
                                discovered.append(pid)
                except Exception:
                    pass
        return sorted(set(discovered))

    def _validate_pid_is_worker(self, pid: int) -> bool:
        """Revalidate PID immediately before termination to guard against PID reuse."""
        managed_pid = self._proc.pid if self._proc is not None and self._proc.poll() is None else None
        try:
            import psutil  # type: ignore

            proc = psutil.Process(pid)
            with proc.oneshot():
                return is_scribasheet_worker_process(
                    pid=pid,
                    exe=proc.exe(),
                    cmdline=proc.cmdline(),
                    cwd=proc.cwd(),
                    repo_root=self.repo_root,
                    managed_pid=managed_pid,
                )
        except ImportError:
            return pid in self._discover_external_worker_pids()
        except Exception:
            return False

    def _terminate_external_pid(self, pid: int, timeout_sec: float = 5.0) -> tuple[bool, str]:
        """Safely terminate a validated external worker PID (graceful first, taskkill fallback)."""
        if not self._validate_pid_is_worker(pid):
            return False, f"Refused to terminate PID {pid}: process is no longer a validated ScribaSheet worker."

        try:
            import psutil  # type: ignore

            proc = psutil.Process(pid)
            proc.terminate()
            try:
                proc.wait(timeout=timeout_sec)
                return True, f"Stopped external worker (PID {pid})."
            except psutil.TimeoutExpired:
                if not self._validate_pid_is_worker(pid):
                    return False, f"PID {pid} changed identity during shutdown; aborted forced kill."
                logger.warning("External worker PID %s did not exit within %.1fs; forcing termination.", pid, timeout_sec)
                if sys.platform == "win32":
                    subprocess.run(
                        ["taskkill", "/PID", str(pid), "/T", "/F"],
                        capture_output=True,
                        text=True,
                        timeout=10,
                        check=False,
                    )
                else:
                    proc.kill()
                try:
                    proc.wait(timeout=3.0)
                except psutil.TimeoutExpired:
                    if psutil.pid_exists(pid):
                        return False, f"External worker PID {pid} did not exit after forced termination."
                return True, f"Stopped external worker (PID {pid})."
        except ImportError:
            if sys.platform == "win32":
                subprocess.run(
                    ["taskkill", "/PID", str(pid), "/T", "/F"],
                    capture_output=True,
                    text=True,
                    timeout=10,
                    check=False,
                )
                return True, f"Stopped external worker (PID {pid})."
            return False, "psutil is unavailable to stop external worker."
        except Exception as exc:
            msg = str(exc)
            if "NoSuchProcess" in type(exc).__name__:
                return True, f"External worker (PID {pid}) already exited."
            if "AccessDenied" in type(exc).__name__:
                return False, f"Permission denied terminating external worker PID {pid}."
            return False, f"Failed to stop external worker PID {pid}: {msg}"

    def _read_log_tail(self, max_lines: int = 12) -> list[str]:
        if not self.log_file.exists():
            return []
        try:
            with self.log_file.open("r", encoding="utf-8", errors="replace") as f:
                lines = deque(f, maxlen=max_lines)
            return [sanitize_log_line(line) for line in lines if line.strip()]
        except Exception:
            return []

    def get_status(self) -> dict[str, Any]:
        with self._lock:
            self._reap_if_exited()
            managed_running = self._proc is not None and self._proc.poll() is None
            external_pids = [] if managed_running else self._discover_external_worker_pids()
            lock_held = False if (managed_running or external_pids) else self._is_external_lock_held()
            external_running = bool(external_pids) or lock_held
            external_manageable = bool(external_pids)
            active_pid = (
                self._proc.pid
                if managed_running and self._proc
                else (external_pids[0] if external_pids else None)
            )
            return {
                "controller_online": True,
                "worker_running": managed_running or external_running,
                "managed_by_controller": managed_running,
                "external_worker_detected": external_running,
                "external_manageable": external_manageable,
                "pid": active_pid,
                "pids": [self._proc.pid] if managed_running and self._proc else external_pids,
                "started_at": self._started_at,
                "last_exit_code": self._last_exit_code,
                "last_error": self._last_error,
                "log_path": str(self.log_file),
                "log_tail": self._read_log_tail(),
            }

    def start(self) -> tuple[bool, str, dict[str, Any]]:
        with self._lock:
            self._reap_if_exited()
            if self._proc is not None and self._proc.poll() is None:
                return True, "Worker is already running.", self.get_status()
            if self._is_external_lock_held():
                return False, "Another worker instance already holds the single-instance lock.", self.get_status()

            self._rotate_log_if_needed()
            self._last_error = None
            env = _load_backend_env(self.backend_dir)
            env["WORKER_LOCK_NAME"] = self.lock_name

            cmd = self._get_worker_cmd()
            self._log_handle = self.log_file.open("a", encoding="utf-8")
            self._log_handle.write(f"[{datetime.now(UTC).isoformat()}] [CONTROLLER] Starting worker: {cmd[0]}\n")
            self._log_handle.flush()

            popen_kwargs: dict[str, Any] = {
                "cwd": str(self.backend_dir),
                "env": env,
                "stdout": self._log_handle,
                "stderr": subprocess.STDOUT,
            }
            if sys.platform == "win32":
                popen_kwargs["creationflags"] = (
                    getattr(subprocess, "CREATE_NO_WINDOW", 0)
                    | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
                )

            try:
                self._proc = subprocess.Popen(cmd, **popen_kwargs)
                self._started_at = datetime.now(UTC).isoformat()
                self._last_exit_code = None
            except Exception as exc:
                self._last_error = f"Failed to start worker: {exc}"
                if self._log_handle is not None:
                    self._log_handle.close()
                    self._log_handle = None
                return False, self._last_error, self.get_status()

            # Brief check to surface immediate startup failures (e.g., missing env vars)
            time.sleep(0.25)
            self._reap_if_exited()
            if self._proc is None:
                msg = self._last_error or "Worker exited immediately after startup. Check logs/worker.log."
                return False, msg, self.get_status()
            return True, "Worker started.", self.get_status()

    def stop(self, timeout_sec: float = 5.0) -> tuple[bool, str, dict[str, Any]]:
        with self._lock:
            self._reap_if_exited()
            if self._proc is None:
                external_pids = self._discover_external_worker_pids()
                if external_pids:
                    errors: list[str] = []
                    for ext_pid in external_pids:
                        ok, msg = self._terminate_external_pid(ext_pid, timeout_sec=timeout_sec)
                        if not ok:
                            errors.append(msg)
                    # Wait briefly for Windows named mutex/lock release after process exit
                    for _ in range(15):
                        if not self._is_external_lock_held():
                            break
                        time.sleep(0.1)
                    if errors:
                        self._last_error = "; ".join(errors)
                        return False, self._last_error, self.get_status()
                    self._last_error = None
                    return True, f"Stopped external worker (PID {', '.join(str(p) for p in external_pids)}).", self.get_status()
                if self._is_external_lock_held():
                    return (
                        False,
                        "Worker lock is held by an external process whose PID could not be verified.",
                        self.get_status(),
                    )
                return True, "Worker is already stopped.", self.get_status()

            proc = self._proc
            try:
                proc.terminate()
                proc.wait(timeout=timeout_sec)
            except subprocess.TimeoutExpired:
                logger.warning("Worker PID %s did not exit within %.1fs; forcing termination.", proc.pid, timeout_sec)
                proc.kill()
                proc.wait(timeout=3.0)
            except Exception as exc:
                self._last_error = f"Error stopping worker: {exc}"

            self._reap_if_exited()
            self._last_error = None
            return True, "Worker stopped.", self.get_status()

    def restart(self) -> tuple[bool, str, dict[str, Any]]:
        with self._lock:
            stopped, msg, status_data = self.stop()
            if not stopped:
                return False, msg, status_data
            return self.start()


def create_controller_server(
    *,
    host: str = DEFAULT_CONTROLLER_HOST,
    port: int = DEFAULT_CONTROLLER_PORT,
    manager: WorkerProcessManager | None = None,
    pairing_token: str | None = None,
    allowed_origins: set[str] | None = None,
) -> ThreadingHTTPServer:
    if host not in ("127.0.0.1", "localhost"):
        raise ValueError(f"Worker controller must bind exclusively to 127.0.0.1, got '{host}'.")

    repo_root = resolve_repo_root()
    mgr = manager or WorkerProcessManager(repo_root=repo_root)
    token = pairing_token or load_or_create_pairing_token(repo_root / "logs" / "worker_controller.token")
    extra_origins = set(allowed_origins or ())

    class ControllerHandler(BaseHTTPRequestHandler):
        server_version = "ScribaSheetWorkerController/1.0"

        def log_message(self, format: str, *args: Any) -> None:
            logger.info("Controller HTTP: " + format, *args)

        def _send_json(self, code: int, payload: dict[str, Any], origin: str | None) -> None:
            body = json.dumps(payload).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Vary", "Origin")
            if origin and is_origin_allowed(origin, extra_origins):
                self.send_header("Access-Control-Allow-Origin", origin)
            self.end_headers()
            self.wfile.write(body)

        def _validate_origin_if_present(self) -> tuple[bool, str | None]:
            origin = self.headers.get("Origin")
            if origin is None:
                return True, None
            if not is_origin_allowed(origin, extra_origins):
                return False, origin
            return True, origin

        def _require_auth(self, origin: str | None, *, require_csrf: bool = False) -> bool:
            if require_csrf:
                if origin is None and not self.headers.get("X-Requested-With"):
                    self._send_json(403, {"detail": "Missing Origin or X-Requested-With CSRF header."}, origin)
                    return False
                if self.headers.get("X-Requested-With") != "ScribaSheet":
                    self._send_json(403, {"detail": "Missing required X-Requested-With header."}, origin)
                    return False
                ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
                if ctype and ctype != "application/json":
                    self._send_json(415, {"detail": "Unsupported Content-Type."}, origin)
                    return False

            provided = self.headers.get("X-Controller-Token", "")
            if not provided or not hmac.compare_digest(provided, token):
                self._send_json(401, {"detail": "Invalid or missing controller pairing token."}, origin)
                return False
            return True

        def do_OPTIONS(self) -> None:
            ok, origin = self._validate_origin_if_present()
            if not ok:
                self._send_json(403, {"detail": "Origin not allowed."}, origin)
                return
            self.send_response(204)
            self.send_header("Vary", "Origin")
            if origin:
                self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Controller-Token, X-Requested-With")
            if self.headers.get("Access-Control-Request-Private-Network") == "true":
                self.send_header("Access-Control-Allow-Private-Network", "true")
            self.send_header("Access-Control-Max-Age", "600")
            self.end_headers()

        def do_GET(self) -> None:
            ok, origin = self._validate_origin_if_present()
            if not ok:
                self._send_json(403, {"detail": "Origin not allowed."}, origin)
                return

            if self.path == "/health":
                self._send_json(
                    200,
                    {"controller_online": True, "requires_pairing": True, "host": host},
                    origin,
                )
                return

            if self.path == "/status":
                if not self._require_auth(origin, require_csrf=False):
                    return
                self._send_json(200, mgr.get_status(), origin)
                return

            self._send_json(404, {"detail": "Not found."}, origin)

        def do_POST(self) -> None:
            ok, origin = self._validate_origin_if_present()
            if not ok:
                self._send_json(403, {"detail": "Origin not allowed."}, origin)
                return

            if not self._require_auth(origin, require_csrf=True):
                return

            if self.path == "/worker/start":
                started, message, status_data = mgr.start()
                self._send_json(200 if started else 409, {"ok": started, "message": message, **status_data}, origin)
                return

            if self.path == "/worker/stop":
                stopped, message, status_data = mgr.stop()
                self._send_json(200 if stopped else 409, {"ok": stopped, "message": message, **status_data}, origin)
                return

            if self.path == "/worker/restart":
                restarted, message, status_data = mgr.restart()
                self._send_json(200 if restarted else 409, {"ok": restarted, "message": message, **status_data}, origin)
                return

            self._send_json(404, {"detail": "Not found."}, origin)

    server = ThreadingHTTPServer((host, port), ControllerHandler)
    server.daemon_threads = True
    return server


def main() -> int:
    host = DEFAULT_CONTROLLER_HOST
    port = int(os.environ.get("WORKER_CONTROLLER_PORT", str(DEFAULT_CONTROLLER_PORT)))
    repo_root = resolve_repo_root()
    token_path = repo_root / "logs" / "worker_controller.token"
    token = load_or_create_pairing_token(token_path)
    manager = WorkerProcessManager(repo_root=repo_root)
    server = create_controller_server(host=host, port=port, manager=manager, pairing_token=token)

    def _shutdown(signum: int, frame: Any) -> None:
        logger.info("Received signal %s; shutting down controller...", signum)
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGINT, _shutdown)
    signal.signal(signal.SIGTERM, _shutdown)

    logger.info("ScribaSheet local worker controller listening on http://%s:%s", host, port)
    logger.info("Pairing token stored at %s", token_path)
    try:
        server.serve_forever()
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
