import asyncio
import logging
from collections import defaultdict

from fastapi import WebSocket

logger = logging.getLogger(__name__)


class JobWebSocketManager:
    def __init__(self) -> None:
        self._connections: dict[str, set[WebSocket]] = defaultdict(set)
        self._loop: asyncio.AbstractEventLoop | None = None

    def set_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    async def connect(self, job_id: str, websocket: WebSocket) -> None:
        await websocket.accept()
        self._connections[job_id].add(websocket)

    def disconnect(self, job_id: str, websocket: WebSocket) -> None:
        self._connections[job_id].discard(websocket)
        if not self._connections[job_id]:
            self._connections.pop(job_id, None)

    async def broadcast(self, job_id: str, payload: dict) -> None:
        conns = list(self._connections.get(job_id, ()))
        for ws in conns:
            try:
                await ws.send_json(payload)
            except Exception:
                self.disconnect(job_id, ws)

    def publish_from_thread(self, job_id: str, payload: dict) -> None:
        if self._loop and self._loop.is_running():
            asyncio.run_coroutine_threadsafe(self.broadcast(job_id, payload), self._loop)


job_ws_manager = JobWebSocketManager()
