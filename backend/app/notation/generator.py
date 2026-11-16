import io
import os
import shutil
import subprocess
import tempfile
import uuid
from collections.abc import Iterable
from pathlib import Path

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
                raw_onset_sec=round(n.onset_sec, 4),
                raw_offset_sec=round(n.offset_sec, 4),
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
    clean = (key_str or "C major").strip()
    lower = clean.lower()
    if lower.endswith(" major"):
        is_minor = False
        tonic = clean[:-6].strip()
    elif lower.endswith(" minor"):
        is_minor = True
        tonic = clean[:-6].strip()
    else:
        is_minor = clean.endswith("m") and len(clean) > 1
        tonic = clean[:-1] if is_minor else clean
    tonic = tonic.replace("b", "-")
    try:
        return music21.key.Key(tonic, "minor" if is_minor else "major")
    except Exception:
        return music21.key.Key("C", "major")


def _split_rh_lh_notes(notes: list[ScoreNote]) -> tuple[list[ScoreNote], list[ScoreNote]]:
    """Assign piano notes to RH (treble) and LH (bass) with hysteresis near Middle C."""
    treble: list[ScoreNote] = []
    bass: list[ScoreNote] = []
    last_hand = "treble"
    for n in sorted(notes, key=lambda x: (x.onset_sec, x.pitch_midi)):
        if n.pitch_midi >= 63:
            hand = "treble"
        elif n.pitch_midi <= 56:
            hand = "bass"
        else:
            # Hysteresis zone (57..62): keep with recent hand unless a simultaneous lower/higher note exists
            hand = last_hand if n.pitch_midi >= 60 or last_hand == "treble" else "bass"
            if n.pitch_midi < 60 and last_hand == "bass":
                hand = "bass"
        last_hand = hand
        if hand == "treble":
            treble.append(n)
        else:
            bass.append(n)
    return treble, bass


def _pack_notes_into_voices(
    notes: Iterable[ScoreNote],
    beats_per_sec: float,
) -> list[list[tuple[float, float, list[int], int]]]:
    """Pack quantized notes into non-overlapping voices: (start_ql, end_ql, pitches, velocity)."""
    sorted_notes = sorted(notes, key=lambda n: (n.onset_sec, n.pitch_midi))
    if not sorted_notes:
        return [[]]

    # Group notes that share the same quantized onset and quantized offset into chords
    raw_events: list[tuple[float, float, int, int]] = []
    for n in sorted_notes:
        start_ql = max(0.0, round(n.onset_sec * beats_per_sec * 4.0) / 4.0)
        end_ql = round(n.offset_sec * beats_per_sec * 4.0) / 4.0
        if end_ql <= start_ql:
            end_ql = start_ql + 0.25
        raw_events.append((start_ql, end_ql, n.pitch_midi, n.velocity))

    # Sort by quantized (start_ql, end_ql, pitch) so chord grouping is deterministic
    raw_events.sort(key=lambda x: (x[0], x[1], x[2]))

    chord_groups: list[tuple[float, float, list[int], int]] = []
    for start_ql, end_ql, pitch, vel in raw_events:
        if (
            chord_groups
            and abs(chord_groups[-1][0] - start_ql) < 1e-6
            and abs(chord_groups[-1][1] - end_ql) < 1e-6
            and pitch not in chord_groups[-1][2]
        ):
            chord_groups[-1][2].append(pitch)
        else:
            chord_groups.append((start_ql, end_ql, [pitch], vel))

    voices: list[list[tuple[float, float, list[int], int]]] = []
    voice_ends: list[float] = []

    for ev in chord_groups:
        start_ql, end_ql, pitches, vel = ev
        placed = False
        for v_idx, v_end in enumerate(voice_ends):
            if start_ql >= v_end - 1e-6:
                voices[v_idx].append((start_ql, end_ql, sorted(pitches), vel))
                voice_ends[v_idx] = end_ql
                placed = True
                break
        if not placed:
            # Allocate a new non-overlapping voice so no musical event is ever dropped
            voices.append([(start_ql, end_ql, sorted(pitches), vel)])
            voice_ends.append(end_ql)

    return voices or [[]]


def _build_m21_element(
    pitches: list[int],
    dur_ql: float,
    velocity: int,
    tie_type: str | None,
) -> music21.note.NotRest:
    if len(pitches) == 1:
        elem: music21.note.NotRest = music21.note.Note(pitches[0])
    else:
        elem = music21.chord.Chord(pitches)
    elem.quarterLength = dur_ql
    elem.volume.velocity = max(1, min(127, velocity))
    if tie_type:
        elem.tie = music21.tie.Tie(tie_type)
    return elem


def _populate_part_from_notes(
    part: music21.stream.Part,
    notes: Iterable[ScoreNote],
    tempo_bpm: float,
    time_sig: str,
    key_obj: music21.key.Key,
    clef_obj: music21.clef.Clef,
    min_measures: int = 1,
) -> None:
    beats_per_sec = max(20.0, tempo_bpm) / 60.0
    ts_obj = music21.meter.TimeSignature(time_sig)
    measure_ql = float(ts_obj.barDuration.quarterLength)

    voices = _pack_notes_into_voices(notes, beats_per_sec)
    max_end_ql = max((ev[1] for v in voices for ev in v), default=measure_ql)
    total_measures = max(min_measures, int(np.ceil(max_end_ql / measure_ql)))

    for m_idx in range(total_measures):
        m_start = m_idx * measure_ql
        m_end = (m_idx + 1) * measure_ql
        m = music21.stream.Measure(number=m_idx + 1)
        if m_idx == 0:
            m.append(clef_obj)
            m.append(music21.meter.TimeSignature(time_sig))
            m.append(key_obj)
            m.append(music21.tempo.MetronomeMark(number=round(tempo_bpm, 1)))

        active_voices: list[tuple[int, list[tuple[float, float, list[int], int]]]] = []
        for v_idx, v_events in enumerate(voices):
            sliced = [
                (ev_s, ev_e, pitches, vel)
                for ev_s, ev_e, pitches, vel in v_events
                if ev_e > m_start + 1e-6 and ev_s < m_end - 1e-6
            ]
            if sliced or v_idx == 0:
                active_voices.append((v_idx + 1, sliced))

        use_voice_containers = len(active_voices) > 1
        for voice_num, v_events in active_voices:
            target_stream: music21.stream.Stream = (
                music21.stream.Voice(id=str(voice_num)) if use_voice_containers else m
            )
            cursor = m_start
            for ev_s, ev_e, pitches, vel in v_events:
                seg_s = max(m_start, ev_s)
                seg_e = min(m_end, ev_e)
                if seg_s > cursor + 1e-6:
                    target_stream.append(music21.note.Rest(quarterLength=round(seg_s - cursor, 4)))
                continues_before = ev_s < m_start - 1e-6
                continues_after = ev_e > m_end + 1e-6
                tie_type: str | None = None
                if continues_before and continues_after:
                    tie_type = "continue"
                elif continues_before:
                    tie_type = "stop"
                elif continues_after:
                    tie_type = "start"

                seg_dur = round(seg_e - seg_s, 4)
                if seg_dur > 1e-6:
                    target_stream.append(_build_m21_element(pitches, seg_dur, vel, tie_type))
                    cursor = seg_e
            if cursor < m_end - 1e-6:
                target_stream.append(music21.note.Rest(quarterLength=round(m_end - cursor, 4)))

            if use_voice_containers:
                m.insert(0, target_stream)

        part.append(m)


def score_data_to_musicxml(score: ScoreData) -> str:
    m21_score = music21.stream.Score()
    m21_score.metadata = music21.metadata.Metadata()
    m21_score.metadata.title = score.title or "ScribaSheet Transcription"

    key_obj = _parse_key_to_music21(score.key_signature)
    time_sig = score.time_signature or "4/4"
    ts_obj = music21.meter.TimeSignature(time_sig)
    measure_ql = float(ts_obj.barDuration.quarterLength)
    beats_per_sec = max(20.0, score.tempo_bpm) / 60.0
    max_note_ql = max((n.offset_sec * beats_per_sec for n in score.notes), default=measure_ql)
    min_measures = max(1, int(np.ceil(max_note_ql / measure_ql)))
    tracks = score.tracks or [ScoreTrack()]

    for track in tracks:
        track_notes = [n for n in score.notes if n.track_index == track.index]
        if track.clef == "grand":
            treble_notes, bass_notes = _split_rh_lh_notes(track_notes)

            p_treble = music21.stream.Part()
            p_treble.partName = f"{track.name} (RH)"
            _populate_part_from_notes(
                p_treble,
                treble_notes,
                score.tempo_bpm,
                time_sig,
                key_obj,
                music21.clef.TrebleClef(),
                min_measures=min_measures,
            )
            m21_score.insert(0, p_treble)

            p_bass = music21.stream.Part()
            p_bass.partName = f"{track.name} (LH)"
            _populate_part_from_notes(
                p_bass,
                bass_notes,
                score.tempo_bpm,
                time_sig,
                key_obj,
                music21.clef.BassClef(),
                min_measures=min_measures,
            )
            m21_score.insert(0, p_bass)

            staff_group = music21.layout.StaffGroup([p_treble, p_bass], symbol="brace")
            m21_score.insert(0, staff_group)
        else:
            clef_obj = music21.clef.BassClef() if track.clef == "bass" else music21.clef.TrebleClef()
            p = music21.stream.Part()
            p.partName = track.name
            _populate_part_from_notes(
                p, track_notes, score.tempo_bpm, time_sig, key_obj, clef_obj, min_measures=min_measures
            )
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


_PC_TO_DIATONIC = [0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6]


def _midi_to_diatonic_step(midi_pitch: int) -> int:
    octave = (midi_pitch // 12) - 1
    return octave * 7 + _PC_TO_DIATONIC[midi_pitch % 12]


def _find_musescore_binary() -> str | None:
    env_bin = os.environ.get("MUSESCORE_BINARY")
    if env_bin and Path(env_bin).exists():
        return env_bin
    for name in ("MuseScore4", "mscore4", "mscore", "musescore"):
        found = shutil.which(name)
        if found:
            return found
    win_default = Path(r"C:\Program Files\MuseScore 4\bin\MuseScore4.exe")
    if win_default.exists():
        return str(win_default)
    return None


def _render_pdf_via_musescore(score: ScoreData) -> bytes | None:
    if os.environ.get("DISABLE_MUSESCORE_PDF", "").lower() in ("1", "true", "yes"):
        return None
    mscore_bin = _find_musescore_binary()
    if not mscore_bin:
        return None
    try:
        xml_str = score_data_to_musicxml(score)
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            xml_path = tmp / "score.musicxml"
            pdf_path = tmp / "score.pdf"
            xml_path.write_text(xml_str, encoding="utf-8")
            res = subprocess.run(
                [mscore_bin, "-o", str(pdf_path), str(xml_path)],
                capture_output=True,
                text=True,
                timeout=45,
                check=False,
            )
            if res.returncode == 0 and pdf_path.exists():
                pdf_bytes = pdf_path.read_bytes()
                if pdf_bytes.startswith(b"%PDF-") and len(pdf_bytes) > 500:
                    return pdf_bytes
    except Exception:
        return None
    return None


def render_score_pdf(score: ScoreData) -> bytes:
    """Render a clean, printable multi-page PDF sheet music document.

    Uses MuseScore CLI engraving from MusicXML when available locally,
    falling back to the ReportLab grand-staff renderer in headless environments.
    """
    musescore_pdf = _render_pdf_via_musescore(score)
    if musescore_pdf is not None:
        return musescore_pdf

    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=letter)
    width, height = letter

    left_margin = 48.0
    right_margin = width - 48.0
    clef_gutter = 26.0
    note_area_left = left_margin + clef_gutter
    usable_w = right_margin - note_area_left - 8.0

    line_gap = 6.0  # 24pt staff height (5 lines)
    step_pt = line_gap / 2.0  # 3.0pt per diatonic step
    staff_height = 4 * line_gap
    bass_offset = 54.0  # distance from treble top to bass top

    # Treble bottom line = E4 (midi 64, diatonic step 30); Bass bottom line = G2 (midi 43, diatonic step 18)
    treble_e4_step = _midi_to_diatonic_step(64)
    bass_g2_step = _midi_to_diatonic_step(43)

    is_grand = any(t.clef == "grand" for t in (score.tracks or [])) or any(
        n.pitch_midi < 57 for n in score.notes
    )

    def draw_header(page_num: int) -> float:
        c.setFont("Helvetica-Bold", 17)
        c.drawCentredString(width / 2, height - 46, score.title or "ScribaSheet Transcription")
        c.setFont("Helvetica", 9.5)
        meta = (
            f"Tempo: {score.tempo_bpm:.0f} BPM  |  Time: {score.time_signature}  |  "
            f"Key: {score.key_signature}  |  Notes: {len(score.notes)}"
        )
        c.drawCentredString(width / 2, height - 64, meta)
        c.setFont("Helvetica", 8)
        c.drawRightString(width - 42, 26, f"ScribaSheet - Page {page_num}")
        return height - 108

    def draw_staff_system(y_treble_top: float, measures_in_sys: int) -> None:
        c.setLineWidth(0.6)
        # Treble 5 lines
        for i in range(5):
            y = y_treble_top - i * line_gap
            c.line(left_margin, y, right_margin, y)
        c.setFont("Helvetica-Bold", 9)
        c.drawString(left_margin + 5, y_treble_top - 17, "G")

        y_bottom_bar = y_treble_top - staff_height
        if is_grand:
            y_bass_top = y_treble_top - bass_offset
            for i in range(5):
                y = y_bass_top - i * line_gap
                c.line(left_margin, y, right_margin, y)
            c.setFont("Helvetica-Bold", 9)
            c.drawString(left_margin + 5, y_bass_top - 15, "F")
            y_bottom_bar = y_bass_top - staff_height
            # Grand-staff left brace bar
            c.setLineWidth(1.4)
            c.line(left_margin - 4, y_treble_top, left_margin - 4, y_bottom_bar)
            c.setLineWidth(0.6)

        # System barlines (aligned across treble & bass)
        c.line(left_margin, y_treble_top, left_margin, y_bottom_bar)
        c.line(right_margin, y_treble_top, right_margin, y_bottom_bar)
        for m in range(1, measures_in_sys):
            bx = note_area_left + (usable_w * (m / float(measures_in_sys)))
            c.line(bx, y_treble_top, bx, y_bottom_bar)

    page_num = 1
    y_cursor = draw_header(page_num)

    sec_per_beat = 60.0 / max(20.0, score.tempo_bpm)
    try:
        beats_per_measure = max(1, int(score.time_signature.split("/")[0]))
    except Exception:
        beats_per_measure = 4
    sec_per_measure = sec_per_beat * beats_per_measure
    total_measures = max(
        4,
        int(np.ceil((max((n.offset_sec for n in score.notes), default=4.0)) / sec_per_measure)),
    )

    measures_per_sys = 4
    system_advance = 114.0 if is_grand else 78.0
    min_y_cursor = 115.0 if is_grand else 85.0

    treble_notes, bass_notes = _split_rh_lh_notes(score.notes) if is_grand else (score.notes, [])
    treble_ids = {n.id for n in treble_notes}

    for sys_start_m in range(0, total_measures, measures_per_sys):
        if y_cursor < min_y_cursor:
            c.showPage()
            page_num += 1
            y_cursor = draw_header(page_num)

        draw_staff_system(y_cursor, measures_per_sys)
        # Measure number placed cleanly in top-left gutter above chord lane
        c.setFont("Helvetica", 7)
        c.drawString(left_margin, y_cursor + 24, f"m. {sys_start_m + 1}")

        sys_start_sec = sys_start_m * sec_per_measure
        sys_dur_sec = measures_per_sys * sec_per_measure
        sys_end_sec = sys_start_sec + sys_dur_sec

        # Draw chords in dedicated lane above treble staff (no collision with measure numbers)
        last_chord_x = -100.0
        for ch in score.chords:
            if sys_start_sec <= ch.onset_sec < sys_end_sec:
                x = note_area_left + ((ch.onset_sec - sys_start_sec) / sys_dur_sec) * usable_w
                if x - last_chord_x < 24.0:
                    x = last_chord_x + 24.0
                c.setFont("Helvetica-Bold", 8.5)
                c.drawString(x, y_cursor + 12, ch.symbol)
                last_chord_x = x

        y_treble_bottom = y_cursor - staff_height
        y_bass_bottom = (y_cursor - bass_offset) - staff_height

        for n in score.notes:
            if not (sys_start_sec <= n.onset_sec < sys_end_sec):
                continue
            x = note_area_left + ((n.onset_sec - sys_start_sec) / sys_dur_sec) * usable_w
            use_treble = (not is_grand) or (n.id in treble_ids)
            if use_treble:
                steps_above = _midi_to_diatonic_step(n.pitch_midi) - treble_e4_step
                ny = y_treble_bottom + steps_above * step_pt
                staff_bot = y_treble_bottom
                staff_top = y_cursor
            else:
                steps_above = _midi_to_diatonic_step(n.pitch_midi) - bass_g2_step
                ny = y_bass_bottom + steps_above * step_pt
                staff_bot = y_bass_bottom
                staff_top = y_cursor - bass_offset

            # Draw ledger lines when outside 5-line staff
            c.setLineWidth(0.5)
            if ny > staff_top + 1.0:
                ly = staff_top + line_gap
                while ly <= ny + 1.0:
                    c.line(x - 4.5, ly, x + 4.5, ly)
                    ly += line_gap
            elif ny < staff_bot - 1.0:
                ly = staff_bot - line_gap
                while ly >= ny - 1.0:
                    c.line(x - 4.5, ly, x + 4.5, ly)
                    ly -= line_gap

            c.circle(x, ny, 2.4, stroke=1, fill=1)
            if steps_above >= 4:
                c.line(x - 2.4, ny, x - 2.4, ny - 13)
            else:
                c.line(x + 2.4, ny, x + 2.4, ny + 13)

        y_cursor -= system_advance

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
        note_off_idx = min(num_samples, int(n.offset_sec * sample_rate))
        hold_len = note_off_idx - start_idx
        if hold_len <= 10:
            continue
        release_samples = int(0.15 * sample_rate)
        end_idx = min(num_samples, note_off_idx + release_samples)
        length = end_idx - start_idx
        t = np.arange(length, dtype=np.float32) / sample_rate
        freq = 440.0 * (2.0 ** ((n.pitch_midi - 69) / 12.0))
        # Warm piano-like harmonic synthesis with attack, gentle string decay, and damper release
        wave = (
            0.65 * np.sin(2.0 * np.pi * freq * t)
            + 0.25 * np.sin(2.0 * np.pi * 2.0 * freq * t)
            + 0.10 * np.sin(2.0 * np.pi * 3.0 * freq * t)
        )
        attack = min(int(0.008 * sample_rate), hold_len // 3)
        env = np.exp(-t * 0.45).astype(np.float32)
        if attack > 0:
            env[:attack] *= np.linspace(0.0, 1.0, attack, dtype=np.float32)
        tail_len = end_idx - note_off_idx
        if tail_len > 0:
            env[hold_len:] *= np.linspace(1.0, 0.0, tail_len, dtype=np.float32)
        amp = (max(1, n.velocity) / 127.0) * 0.24
        mix[start_idx:end_idx] += wave * env * amp

    peak = float(np.max(np.abs(mix))) if len(mix) > 0 else 0.0
    if peak > 0.95:
        mix = (mix / peak) * 0.95

    buf = io.BytesIO()
    sf.write(buf, mix, sample_rate, format="WAV", subtype="PCM_16")
    return buf.getvalue()
