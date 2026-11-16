from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


@dataclass
class DetectedNote:
    pitch_midi: int
    onset_sec: float
    offset_sec: float
    velocity: int
    confidence: float | None = None


@dataclass
class TranscriptionOutput:
    engine: str
    notes: list[DetectedNote]
    midi_bytes: bytes
    duration_seconds: float
    metadata: dict[str, Any] = field(default_factory=dict)


class TranscriptionProvider(ABC):
    name: str = "base"

    @abstractmethod
    def transcribe(
        self,
        wav_path: Path,
        *,
        onset_threshold: float = 0.5,
        frame_threshold: float = 0.3,
        min_note_length_ms: float = 58.0,
        min_midi_pitch: int = 21,
        max_midi_pitch: int = 108,
        midi_program: int = 0,
        transpose_semitones: int = 0,
    ) -> TranscriptionOutput:
        raise NotImplementedError
