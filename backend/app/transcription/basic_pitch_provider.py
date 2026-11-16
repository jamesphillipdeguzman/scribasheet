import io
import logging
from pathlib import Path

import librosa
import pretty_midi

from app.transcription.base import DetectedNote, TranscriptionOutput, TranscriptionProvider

logger = logging.getLogger(__name__)


def _midi_to_hz(midi_note: int) -> float:
    return float(librosa.midi_to_hz(midi_note))


def _resolve_onnx_model_path() -> Path:
    import basic_pitch

    pkg_dir = Path(basic_pitch.__file__).resolve().parent
    onnx_candidate = pkg_dir / "saved_models" / "icassp_2022" / "nmp.onnx"
    if onnx_candidate.exists():
        return onnx_candidate
    # Fallback to ICASSP_2022_MODEL_PATH if TensorFlow SavedModel is used
    return Path(basic_pitch.ICASSP_2022_MODEL_PATH)


class BasicPitchProvider(TranscriptionProvider):
    """Genuine AI audio-to-MIDI transcription powered by Spotify Basic Pitch (ONNX Runtime)."""

    name = "basic_pitch"

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
        from basic_pitch.inference import predict

        model_path = _resolve_onnx_model_path()
        min_freq = _midi_to_hz(max(0, min_midi_pitch))
        max_freq = _midi_to_hz(min(127, max_midi_pitch))

        logger.info(
            "Running Basic Pitch inference on %s (model=%s, onset=%.2f, frame=%.2f)",
            wav_path.name,
            model_path.name,
            onset_threshold,
            frame_threshold,
        )

        _, midi_data, note_events = predict(
            audio_path=str(wav_path),
            model_or_model_path=str(model_path),
            onset_threshold=onset_threshold,
            frame_threshold=frame_threshold,
            minimum_note_length=min_note_length_ms,
            minimum_frequency=min_freq,
            maximum_frequency=max_freq,
            multiple_pitch_bends=False,
            melodia_trick=True,
        )

        detected_notes: list[DetectedNote] = []
        pm = pretty_midi.PrettyMIDI()
        instrument = pretty_midi.Instrument(program=max(0, min(127, midi_program)))

        for event in note_events:
            # basic_pitch note_events tuple: (start_time_s, end_time_s, pitch_midi, amplitude, pitch_bends)
            start_s = max(0.0, float(event[0]))
            end_s = max(start_s + 0.03, float(event[1]))
            pitch = int(event[2]) + transpose_semitones
            if pitch < 0 or pitch > 127:
                continue
            amplitude = float(event[3]) if len(event) > 3 else 0.7
            confidence = max(0.0, min(1.0, amplitude))
            velocity = max(20, min(127, int(round(confidence * 110 + 17))))

            detected_notes.append(
                DetectedNote(
                    pitch_midi=pitch,
                    onset_sec=round(start_s, 4),
                    offset_sec=round(end_s, 4),
                    velocity=velocity,
                    confidence=round(confidence, 4),
                )
            )
            instrument.notes.append(
                pretty_midi.Note(
                    velocity=velocity,
                    pitch=pitch,
                    start=start_s,
                    end=end_s,
                )
            )

        detected_notes.sort(key=lambda n: (n.onset_sec, n.pitch_midi))
        pm.instruments.append(instrument)

        midi_buf = io.BytesIO()
        pm.write(midi_buf)
        midi_bytes = midi_buf.getvalue()

        duration = float(pm.get_end_time()) if detected_notes else 0.0
        return TranscriptionOutput(
            engine=self.name,
            notes=detected_notes,
            midi_bytes=midi_bytes,
            duration_seconds=duration,
            metadata={
                "model": str(model_path.name),
                "note_count": len(detected_notes),
                "raw_midi_instruments": len(midi_data.instruments) if midi_data else 0,
            },
        )
