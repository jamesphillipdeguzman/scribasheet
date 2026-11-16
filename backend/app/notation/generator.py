import io
import uuid
from collections.abc import Iterable

import music21
import numpy as np
import pretty_midi
import soundfile as sf
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas

from app.notation.analyzer import (
    assign_guitar_tab,
    detect_chords,
    get_instrument_program_and_clef,
    quantize_seconds,
)
from app.schemas.score import ScoreData, ScoreNote, ScoreTrack
from app.transcription.base import DetectedNote


def build_score_data(
    *,
    title: str,
    detected_notes: list[DetectedNote],
    tempo_bpm: float,
    tempo_estimated: bool,
    time_signature: str,
    time_signature_estimated: bool,
    key_signature: str,
    key_signature_estimated: bool,
    duration_seconds: float,
    instrument: str,
    quantization: str = "sixteenth",
    analysis: dict | None = None,
) -> ScoreData:
    program, clef = get_instrument_program_and_clef(instrument)
    is_guitar = "guitar" in instrument.lower()
    sec_per_beat = 60.0 / max(20.0, tempo_bpm)
    min_dur = max(0.05, sec_per_beat * 0.125)

    score_notes: list[ScoreNote] = []
    for n in detected_notes:
        onset = quantize_seconds(n.onset_sec, tempo_bpm, quantization)
        offset = quantize_seconds(n.offset_sec, tempo_bpm, quantization)
        if offset <= onset:
            offset = round(onset + min_dur, 4)
        str_num, fret_num = assign_guitar_tab(n.pitch_midi) if is_guitar else (None, None)
        score_notes.append(
            ScoreNote(
                id=uuid.uuid4().hex[:12],
                pitch_midi=n.pitch_midi,
                onset_sec=onset,
                offset_sec=offset,
                velocity=n.velocity,
                confidence=n.confidence,
                track_index=0,
                string_num=str_num,
                fret_num=fret_num,
            )
        )

    score_notes.sort(key=lambda x: (x.onset_sec, x.pitch_midi))
    chords = detect_chords(score_notes, tempo_bpm, time_signature)

    track = ScoreTrack(
        index=0,
        name=instrument.replace("_", " ").title(),
        instrument=instrument,
        clef=clef,
        program=program,
        muted=False,
    )

    return ScoreData(
        title=title,
        tempo_bpm=tempo_bpm,
        tempo_estimated=tempo_estimated,
        time_signature=time_signature,
        time_signature_estimated=time_signature_estimated,
        key_signature=key_signature,
        key_signature_estimated=key_signature_estimated,
        duration_seconds=round(duration_seconds, 3),
        tracks=[track],
        notes=score_notes,
        chords=chords,
        analysis=analysis or {},
    )


def _parse_key_to_music21(key_str: str) -> music21.key.Key:
    clean = (key_str or "C").strip()
    is_minor = clean.endswith("m") and len(clean) > 1
    tonic = clean[:-1] if is_minor else clean
    tonic = tonic.replace("b", "-")
    try:
        return music21.key.Key(tonic, "minor" if is_minor else "major")
    except Exception:
        return music21.key.Key("C", "major")


def _populate_part_from_notes(
    part: music21.stream.Part,
    notes: Iterable[ScoreNote],
    tempo_bpm: float,
    time_sig: str,
    key_obj: music21.key.Key,
    clef_obj: music21.clef.Clef,
) -> None:
    beats_per_sec = max(20.0, tempo_bpm) / 60.0
    part.append(clef_obj)
    part.append(music21.meter.TimeSignature(time_sig))
    part.append(key_obj)
    part.append(music21.tempo.MetronomeMark(number=round(tempo_bpm, 1)))

    # Group nearly-simultaneous notes into chords so music21 renders clean polyphony
    sorted_notes = sorted(notes, key=lambda n: (n.onset_sec, n.pitch_midi))
    groups: list[list[ScoreNote]] = []
    for n in sorted_notes:
        if groups and abs(n.onset_sec - groups[-1][0].onset_sec) < 0.04:
            groups[-1].append(n)
        else:
            groups.append([n])

    for grp in groups:
        onset_beats = max(0.0, round(grp[0].onset_sec * beats_per_sec * 4) / 4.0)
        avg_dur_sec = max(0.08, sum(n.offset_sec - n.onset_sec for n in grp) / len(grp))
        dur_beats = max(0.25, round(avg_dur_sec * beats_per_sec * 4) / 4.0)

        pitches = sorted({n.pitch_midi for n in grp})
        if len(pitches) == 1:
            elem: music21.note.NotRest = music21.note.Note(pitches[0])
        else:
            elem = music21.chord.Chord(pitches)
        elem.quarterLength = dur_beats
        elem.volume.velocity = grp[0].velocity
        part.insert(onset_beats + 0.0, elem)

    part.makeMeasures(inPlace=True)
    if len(part.getElementsByClass(music21.stream.Measure)) == 0:
        m = music21.stream.Measure(number=1)
        m.append(music21.note.Rest(quarterLength=4.0))
        part.append(m)


def score_data_to_musicxml(score: ScoreData) -> str:
    m21_score = music21.stream.Score()
    m21_score.metadata = music21.metadata.Metadata()
    m21_score.metadata.title = score.title or "ScribaSheet Transcription"

    key_obj = _parse_key_to_music21(score.key_signature)
    time_sig = score.time_signature or "4/4"
    tracks = score.tracks or [ScoreTrack()]

    for track in tracks:
        track_notes = [n for n in score.notes if n.track_index == track.index]
        if track.clef == "grand":
            treble_notes = [n for n in track_notes if n.pitch_midi >= 60]
            bass_notes = [n for n in track_notes if n.pitch_midi < 60]

            p_treble = music21.stream.Part()
            p_treble.partName = f"{track.name} (RH)"
            _populate_part_from_notes(
                p_treble, treble_notes, score.tempo_bpm, time_sig, key_obj, music21.clef.TrebleClef()
            )
            m21_score.insert(0, p_treble)

            p_bass = music21.stream.Part()
            p_bass.partName = f"{track.name} (LH)"
            _populate_part_from_notes(
                p_bass, bass_notes, score.tempo_bpm, time_sig, key_obj, music21.clef.BassClef()
            )
            m21_score.insert(0, p_bass)

            staff_group = music21.layout.StaffGroup([p_treble, p_bass], symbol="brace")
            m21_score.insert(0, staff_group)
        else:
            clef_obj = music21.clef.BassClef() if track.clef == "bass" else music21.clef.TrebleClef()
            p = music21.stream.Part()
            p.partName = track.name
            _populate_part_from_notes(p, track_notes, score.tempo_bpm, time_sig, key_obj, clef_obj)
            m21_score.insert(0, p)

    exporter = music21.musicxml.m21ToXml.GeneralObjectExporter(m21_score)
    xml_bytes = exporter.parse()
    return xml_bytes.decode("utf-8")


def score_data_to_midi_bytes(score: ScoreData) -> bytes:
    pm = pretty_midi.PrettyMIDI(initial_tempo=max(20.0, float(score.tempo_bpm)))
    tracks = score.tracks or [ScoreTrack()]
    track_map = {t.index: t for t in tracks}

    instruments: dict[int, pretty_midi.Instrument] = {}
    for t in tracks:
        inst = pretty_midi.Instrument(program=max(0, min(127, t.program)), name=t.name)
        instruments[t.index] = inst

    for n in score.notes:
        t_idx = n.track_index if n.track_index in instruments else 0
        if t_idx not in instruments:
            t_meta = track_map.get(t_idx, ScoreTrack())
            instruments[t_idx] = pretty_midi.Instrument(program=t_meta.program, name=t_meta.name)
        instruments[t_idx].notes.append(
            pretty_midi.Note(
                velocity=max(1, min(127, n.velocity)),
                pitch=max(0, min(127, n.pitch_midi)),
                start=max(0.0, float(n.onset_sec)),
                end=max(float(n.onset_sec) + 0.03, float(n.offset_sec)),
            )
        )

    for inst in instruments.values():
        pm.instruments.append(inst)

    buf = io.BytesIO()
    pm.write(buf)
    return buf.getvalue()


def render_score_pdf(score: ScoreData) -> bytes:
    """Render a clean, printable multi-page PDF sheet music document from actual score data."""
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=letter)
    width, height = letter

    def draw_header(page_num: int) -> float:
        c.setFont("Helvetica-Bold", 18)
        c.drawCentredString(width / 2, height - 48, score.title or "ScribaSheet Transcription")
        c.setFont("Helvetica", 10)
        meta = (
            f"Tempo: {score.tempo_bpm:.0f} BPM  |  Time: {score.time_signature}  |  "
            f"Key: {score.key_signature}  |  Notes: {len(score.notes)}"
        )
        c.drawCentredString(width / 2, height - 66, meta)
        c.setFont("Helvetica", 8)
        c.drawRightString(width - 42, 28, f"ScribaSheet • Page {page_num}")
        return height - 105

    def draw_staff_system(y_top: float) -> float:
        left = 48
        right = width - 48
        c.setLineWidth(0.6)
        for i in range(5):
            y = y_top - i * 7
            c.line(left, y, right, y)
        # Barlines
        c.line(left, y_top, left, y_top - 28)
        c.line(right, y_top, right, y_top - 28)
        for m in range(1, 4):
            bx = left + (right - left) * (m / 4.0)
            c.line(bx, y_top, bx, y_top - 28)
        return y_top

    page_num = 1
    y_cursor = draw_header(page_num)

    # Group notes into systems of 4 measures
    sec_per_beat = 60.0 / max(20.0, score.tempo_bpm)
    try:
        beats_per_measure = int(score.time_signature.split("/")[0])
    except Exception:
        beats_per_measure = 4
    sec_per_measure = sec_per_beat * beats_per_measure
    total_measures = max(
        4,
        int(np.ceil((max((n.offset_sec for n in score.notes), default=4.0)) / sec_per_measure)),
    )

    left = 54
    usable_w = width - 108

    for sys_start_m in range(0, total_measures, 4):
        if y_cursor < 100:
            c.showPage()
            page_num += 1
            y_cursor = draw_header(page_num)

        draw_staff_system(y_cursor)
        c.setFont("Helvetica", 7)
        c.drawString(48, y_cursor + 8, f"m. {sys_start_m + 1}")

        sys_start_sec = sys_start_m * sec_per_measure
        sys_end_sec = (sys_start_m + 4) * sec_per_measure

        # Draw chords above staff
        for ch in score.chords:
            if sys_start_sec <= ch.onset_sec < sys_end_sec:
                x = left + ((ch.onset_sec - sys_start_sec) / (4 * sec_per_measure)) * usable_w
                c.setFont("Helvetica-Bold", 8)
                c.drawString(x, y_cursor + 10, ch.symbol)

        # Draw noteheads on staff (E4=64 on bottom line y_cursor-28, 3.5pt per diatonic step approx)
        for n in score.notes:
            if sys_start_sec <= n.onset_sec < sys_end_sec:
                x = left + ((n.onset_sec - sys_start_sec) / (4 * sec_per_measure)) * usable_w
                semitones_above_e4 = n.pitch_midi - 64
                ny = (y_cursor - 28) + semitones_above_e4 * 2.1
                ny = max(y_cursor - 44, min(y_cursor + 14, ny))
                c.circle(x, ny, 2.6, stroke=1, fill=1)
                c.line(x + 2.6, ny, x + 2.6, ny + 14)

        y_cursor -= 72

    c.save()
    return buf.getvalue()


def render_score_wav(score: ScoreData, sample_rate: int = 22050) -> bytes:
    """Synthesize genuine polyphonic audio from the score's notes into a WAV file."""
    total_dur = max(
        1.0,
        max((n.offset_sec for n in score.notes), default=1.0) + 0.5,
    )
    num_samples = int(total_dur * sample_rate)
    mix = np.zeros(num_samples, dtype=np.float32)

    for n in score.notes:
        start_idx = max(0, int(n.onset_sec * sample_rate))
        end_idx = min(num_samples, int(n.offset_sec * sample_rate))
        length = end_idx - start_idx
        if length <= 10:
            continue
        t = np.arange(length, dtype=np.float32) / sample_rate
        freq = 440.0 * (2.0 ** ((n.pitch_midi - 69) / 12.0))
        # Warm piano-like harmonic synthesis with ADSR envelope
        wave = (
            0.65 * np.sin(2.0 * np.pi * freq * t)
            + 0.25 * np.sin(2.0 * np.pi * 2.0 * freq * t)
            + 0.10 * np.sin(2.0 * np.pi * 3.0 * freq * t)
        )
        attack = min(int(0.012 * sample_rate), length // 3)
        release = min(int(0.08 * sample_rate), length // 2)
        env = np.ones(length, dtype=np.float32)
        if attack > 0:
            env[:attack] = np.linspace(0.0, 1.0, attack, dtype=np.float32)
        if release > 0:
            env[-release:] = np.linspace(1.0, 0.0, release, dtype=np.float32)
        amp = (n.velocity / 127.0) * 0.22
        mix[start_idx:end_idx] += wave * env * amp

    peak = float(np.max(np.abs(mix))) if len(mix) > 0 else 0.0
    if peak > 0.95:
        mix = (mix / peak) * 0.95

    buf = io.BytesIO()
    sf.write(buf, mix, sample_rate, format="WAV", subtype="PCM_16")
    return buf.getvalue()
