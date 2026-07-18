from __future__ import annotations

import asyncio
import uuid
from collections import defaultdict
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from nexus_api.schemas import EventEnvelope


@dataclass(frozen=True)
class EventSubscription:
    queue: asyncio.Queue[EventEnvelope]
    start_sequence: int


class EventBroker:
    """In-process fan-out for live dashboards.

    The interface is deliberately small so Redis/NATS can replace it without
    changing the domain service or WebSocket contract.
    """

    def __init__(self, queue_size: int = 100) -> None:
        self._queue_size = queue_size
        self._subscribers: dict[str, set[asyncio.Queue[EventEnvelope]]] = defaultdict(set)
        self._sequences: defaultdict[str, int] = defaultdict(int)
        self._stream_id = str(uuid.uuid4())

    @property
    def stream_id(self) -> str:
        return self._stream_id

    def current_sequence(self, project_id: str) -> int:
        return self._sequences[project_id]

    async def publish(self, project_id: str, event_type: str, data: dict[str, Any]) -> None:
        self._sequences[project_id] += 1
        emitted_at = datetime.now(UTC)
        event = EventEnvelope(
            stream_id=self._stream_id,
            sequence=self._sequences[project_id],
            type=event_type,
            project_id=project_id,
            emitted_at=emitted_at,
            timestamp=emitted_at,
            data=data,
        )
        for queue in tuple(self._subscribers.get(project_id, set())):
            if queue.full():
                try:
                    queue.get_nowait()
                except asyncio.QueueEmpty:
                    pass
            queue.put_nowait(event)

    @asynccontextmanager
    async def subscribe(self, project_id: str) -> AsyncIterator[EventSubscription]:
        queue: asyncio.Queue[EventEnvelope] = asyncio.Queue(maxsize=self._queue_size)
        self._subscribers[project_id].add(queue)
        try:
            yield EventSubscription(
                queue=queue,
                start_sequence=self.current_sequence(project_id),
            )
        finally:
            self._subscribers[project_id].discard(queue)
            if not self._subscribers[project_id]:
                self._subscribers.pop(project_id, None)
