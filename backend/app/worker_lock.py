"""
Cross-platform single-instance lock for the ScribaSheet local worker agent.

On Windows, uses a kernel-managed named mutex (CreateMutexW) so that:
- Lock acquisition is atomic across Scheduled Task and manual terminal launches.
- Crashes or forced terminations automatically release the kernel handle (no stale lock files).
- Normal shutdown releases the mutex and closes the handle cleanly.

On POSIX platforms (used in non-Windows CI or fallback environments), uses fcntl.flock.
"""

from __future__ import annotations

import ctypes
import logging
import os
import sys
from pathlib import Path

logger = logging.getLogger("scribasheet.worker_lock")

ERROR_ALREADY_EXISTS = 183
WAIT_OBJECT_0 = 0x00000000
WAIT_ABANDONED = 0x00000080


class WorkerSingleInstanceLock:
    """Atomic single-instance guard for the ScribaSheet worker process."""

    def __init__(self, lock_name: str = "Local\\ScribaSheetTranscriptionWorker") -> None:
        self.lock_name = lock_name
        self._handle: int | None = None
        self._lock_file = None
        self._acquired = False

    @property
    def is_acquired(self) -> bool:
        return self._acquired

    def acquire(self) -> bool:
        """Attempt to acquire the single-instance lock without blocking.

        Returns True if this process now owns the lock, or False if another
        active worker instance already holds it.
        """
        if self._acquired:
            return True

        if sys.platform == "win32":
            return self._acquire_windows_mutex()
        return self._acquire_posix_flock()

    def _acquire_windows_mutex(self) -> bool:
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CreateMutexW.argtypes = [ctypes.c_void_p, ctypes.c_bool, ctypes.c_wchar_p]
        kernel32.CreateMutexW.restype = ctypes.c_void_p
        kernel32.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
        kernel32.WaitForSingleObject.restype = ctypes.c_uint32
        kernel32.ReleaseMutex.argtypes = [ctypes.c_void_p]
        kernel32.ReleaseMutex.restype = ctypes.c_bool
        kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
        kernel32.CloseHandle.restype = ctypes.c_bool

        handle = kernel32.CreateMutexW(None, False, self.lock_name)
        if not handle:
            err = ctypes.get_last_error()
            raise OSError(err, f"CreateMutexW failed for '{self.lock_name}' (error={err})")

        wait_res = kernel32.WaitForSingleObject(handle, 0)
        if wait_res in (WAIT_OBJECT_0, WAIT_ABANDONED):
            if wait_res == WAIT_ABANDONED:
                logger.warning(
                    "Recovered abandoned worker mutex '%s' from a previously terminated process.",
                    self.lock_name,
                )
            self._handle = int(handle)
            self._acquired = True
            return True

        kernel32.CloseHandle(handle)
        return False

    def _acquire_posix_flock(self) -> bool:
        import fcntl

        safe_name = self.lock_name.replace("\\", "_").replace("/", "_")
        lock_path = Path(os.environ.get("TMPDIR", "/tmp")) / f"{safe_name}.lock"
        f = lock_path.open("a+")
        try:
            fcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            f.close()
            return False
        self._lock_file = f
        self._acquired = True
        return True

    def release(self) -> None:
        """Release the single-instance lock if held by this process."""
        if not self._acquired:
            return

        if sys.platform == "win32":
            if self._handle is not None:
                kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
                kernel32.ReleaseMutex.argtypes = [ctypes.c_void_p]
                kernel32.ReleaseMutex.restype = ctypes.c_bool
                kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
                kernel32.CloseHandle.restype = ctypes.c_bool
                try:
                    kernel32.ReleaseMutex(ctypes.c_void_p(self._handle))
                finally:
                    kernel32.CloseHandle(ctypes.c_void_p(self._handle))
                    self._handle = None
        elif self._lock_file is not None:
            import fcntl

            try:
                fcntl.flock(self._lock_file.fileno(), fcntl.LOCK_UN)
            finally:
                self._lock_file.close()
                self._lock_file = None

        self._acquired = False

    def __enter__(self) -> WorkerSingleInstanceLock:
        if not self.acquire():
            raise RuntimeError(f"Worker lock '{self.lock_name}' is already held by another instance.")
        return self

    def __exit__(self, exc_type, exc_val, exc_tb) -> None:
        self.release()
