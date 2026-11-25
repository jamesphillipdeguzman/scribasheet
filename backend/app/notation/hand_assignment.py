"""Contextual sequence-aware RH/LH piano hand assignment using Viterbi dynamic programming."""

from __future__ import annotations

from dataclasses import dataclass

from app.schemas.score import ScoreNote

_DEFAULT_LH_CENTER = 48.0  # C3
_DEFAULT_RH_CENTER = 67.0  # G4


@dataclass(frozen=True)
class _HandCandidate:
    lh_notes: tuple[ScoreNote, ...]
    rh_notes: tuple[ScoreNote, ...]
    lh_mean: float | None
    rh_mean: float | None
    unary_score: float


@dataclass(frozen=True)
class _RunningHandState:
    lh_center: float
    rh_center: float
    last_lh_onset: float | None
    last_rh_onset: float | None
    last_active: str  # "lh" | "rh" | "both"


def _cluster_notes_by_onset(
    notes: list[ScoreNote],
    window_sec: float = 0.035,
) -> list[list[ScoreNote]]:
    ordered = sorted(notes, key=lambda n: (n.onset_sec, n.pitch_midi))
    if not ordered:
        return []
    clusters: list[list[ScoreNote]] = [[ordered[0]]]
    anchor_onset = ordered[0].onset_sec
    for n in ordered[1:]:
        if n.onset_sec - anchor_onset <= window_sec:
            clusters[-1].append(n)
        else:
            clusters.append([n])
            anchor_onset = n.onset_sec
    return clusters


def _hand_span(notes: tuple[ScoreNote, ...]) -> int:
    if len(notes) <= 1:
        return 0
    return max(n.pitch_midi for n in notes) - min(n.pitch_midi for n in notes)


def _unary_partition_score(
    lh: tuple[ScoreNote, ...],
    rh: tuple[ScoreNote, ...],
) -> float:
    score = 0.0
    lh_span = _hand_span(lh)
    rh_span = _hand_span(rh)

    # Ergonomic span playability: strongly penalize simultaneous spans exceeding an octave (12 st)
    if lh_span > 12:
        score -= (lh_span - 12) * 5.5
    elif lh and ((len(lh) >= 3 and lh_span <= 10) or (len(lh) == 2 and lh_span <= 12)):
        score += 1.2
    if rh_span > 12:
        score -= (rh_span - 12) * 5.5
    elif rh and ((len(rh) >= 3 and rh_span <= 10) or (len(rh) == 2 and rh_span <= 12)):
        score += 1.2

    # Gentle ergonomic register priors (soft enough for sequence continuity to override)
    if lh:
        lh_mean = sum(n.pitch_midi for n in lh) / len(lh)
        score -= 0.14 * abs(lh_mean - _DEFAULT_LH_CENTER)
        if lh_mean > 76:
            score -= (lh_mean - 76) * 0.45
    if rh:
        rh_mean = sum(n.pitch_midi for n in rh) / len(rh)
        score -= 0.14 * abs(rh_mean - _DEFAULT_RH_CENTER)
        if rh_mean < 43:
            score -= (43 - rh_mean) * 0.45

    # When splitting a simultaneous cluster into both hands, reward natural spacing
    # while discouraging unnecessary splits of compact 2-3 note single-hand triads.
    if lh and rh:
        lh_hi = max(n.pitch_midi for n in lh)
        rh_lo = min(n.pitch_midi for n in rh)
        gap = rh_lo - lh_hi
        if gap >= 0:
            score += min(gap, 12) * 0.25
        else:
            # Crossed simultaneous cluster: mild penalty unless justified by trajectory
            score -= 1.4
        total_span = max(n.pitch_midi for n in (*lh, *rh)) - min(n.pitch_midi for n in (*lh, *rh))
        if total_span <= 7 and len(lh) + len(rh) <= 3:
            score -= 1.6

    return score


def _build_candidates(cluster: list[ScoreNote]) -> list[_HandCandidate]:
    m = len(cluster)
    if m == 1:
        n = cluster[0]
        return [
            _HandCandidate(
                lh_notes=(n,),
                rh_notes=(),
                lh_mean=float(n.pitch_midi),
                rh_mean=None,
                unary_score=_unary_partition_score((n,), ()),
            ),
            _HandCandidate(
                lh_notes=(),
                rh_notes=(n,),
                lh_mean=None,
                rh_mean=float(n.pitch_midi),
                unary_score=_unary_partition_score((), (n,)),
            ),
        ]

    candidates: list[_HandCandidate] = []
    full = tuple(cluster)
    full_span = _hand_span(full)

    # All-LH and All-RH options when playable by one hand
    if full_span <= 16:
        candidates.append(
            _HandCandidate(
                lh_notes=full,
                rh_notes=(),
                lh_mean=sum(n.pitch_midi for n in full) / m,
                rh_mean=None,
                unary_score=_unary_partition_score(full, ()),
            )
        )
        candidates.append(
            _HandCandidate(
                lh_notes=(),
                rh_notes=full,
                lh_mean=None,
                rh_mean=sum(n.pitch_midi for n in full) / m,
                unary_score=_unary_partition_score((), full),
            )
        )

    # Standard ordered splits LH = cluster[:k], RH = cluster[k:]
    split_candidates: list[_HandCandidate] = []
    for k in range(1, m):
        lh = tuple(cluster[:k])
        rh = tuple(cluster[k:])
        split_candidates.append(
            _HandCandidate(
                lh_notes=lh,
                rh_notes=rh,
                lh_mean=sum(n.pitch_midi for n in lh) / len(lh),
                rh_mean=sum(n.pitch_midi for n in rh) / len(rh),
                unary_score=_unary_partition_score(lh, rh),
            )
        )

    # Keep playable splits (both spans <= 16), or fallback to best-span split if wide
    playable_splits = [c for c in split_candidates if _hand_span(c.lh_notes) <= 16 and _hand_span(c.rh_notes) <= 16]
    if playable_splits:
        candidates.extend(playable_splits)
    elif split_candidates:
        candidates.append(max(split_candidates, key=lambda c: c.unary_score))

    # Support simultaneous crossed-hand 2-note clusters (LH above RH)
    if m == 2 and full_span <= 14:
        lh = (cluster[1],)
        rh = (cluster[0],)
        candidates.append(
            _HandCandidate(
                lh_notes=lh,
                rh_notes=rh,
                lh_mean=float(cluster[1].pitch_midi),
                rh_mean=float(cluster[0].pitch_midi),
                unary_score=_unary_partition_score(lh, rh),
            )
        )

    return candidates


def _transition_score(
    prev_state: _RunningHandState,
    prev_cand: _HandCandidate,
    cur_cand: _HandCandidate,
    gap_sec: float,
) -> float:
    score = 0.0
    # Across long rests (> 1.4s), hand-position memory decays naturally
    decay = 0.35 if gap_sec > 1.4 else (0.70 if gap_sec > 0.7 else 1.0)

    if cur_cand.lh_mean is not None:
        if prev_state.last_lh_onset is not None:
            dist = abs(cur_cand.lh_mean - prev_state.lh_center)
            if dist <= 7.0:
                score += 2.6 * decay
            elif dist <= 12.0:
                score += 1.3 * decay
            else:
                score -= (dist - 12.0) * 0.32 * decay

    if cur_cand.rh_mean is not None:
        if prev_state.last_rh_onset is not None:
            dist = abs(cur_cand.rh_mean - prev_state.rh_center)
            if dist <= 7.0:
                score += 2.6 * decay
            elif dist <= 12.0:
                score += 1.3 * decay
            else:
                score -= (dist - 12.0) * 0.32 * decay

    # Same-hand persistence for rapid consecutive single-note runs / arpeggios
    prev_is_single = len(prev_cand.lh_notes) + len(prev_cand.rh_notes) == 1
    cur_is_single = len(cur_cand.lh_notes) + len(cur_cand.rh_notes) == 1
    cur_active = "both" if (cur_cand.lh_notes and cur_cand.rh_notes) else ("lh" if cur_cand.lh_notes else "rh")
    if prev_is_single and cur_is_single and prev_state.last_active == cur_active and gap_sec <= 0.45:
        prev_m = prev_cand.lh_mean if cur_active == "lh" else prev_cand.rh_mean
        cur_m = cur_cand.lh_mean if cur_active == "lh" else cur_cand.rh_mean
        if prev_m is not None and cur_m is not None and abs(cur_m - prev_m) <= 8.0:
            score += 2.8
    elif prev_is_single and cur_is_single and prev_state.last_active != cur_active:
        # Penalize unnecessary hand ping-ponging between close single notes
        prev_m = prev_cand.lh_mean if prev_state.last_active == "lh" else prev_cand.rh_mean
        cur_m = cur_cand.lh_mean if cur_active == "lh" else cur_cand.rh_mean
        if gap_sec <= 0.35 and prev_m is not None and cur_m is not None and abs(cur_m - prev_m) <= 5.0:
            score -= 2.2

    return score


def _advance_state(
    prev_state: _RunningHandState,
    cand: _HandCandidate,
    onset_sec: float,
) -> _RunningHandState:
    alpha = 0.75
    lh_center = (
        prev_state.lh_center * (1.0 - alpha) + cand.lh_mean * alpha
        if cand.lh_mean is not None
        else prev_state.lh_center
    )
    rh_center = (
        prev_state.rh_center * (1.0 - alpha) + cand.rh_mean * alpha
        if cand.rh_mean is not None
        else prev_state.rh_center
    )
    last_lh = onset_sec if cand.lh_notes else prev_state.last_lh_onset
    last_rh = onset_sec if cand.rh_notes else prev_state.last_rh_onset
    active = "both" if (cand.lh_notes and cand.rh_notes) else ("lh" if cand.lh_notes else "rh")
    return _RunningHandState(
        lh_center=lh_center,
        rh_center=rh_center,
        last_lh_onset=last_lh,
        last_rh_onset=last_rh,
        last_active=active,
    )


def assign_hands_contextual(notes: list[ScoreNote]) -> tuple[list[ScoreNote], list[ScoreNote]]:
    """Assign piano notes to (treble_rh_notes, bass_lh_notes) using Viterbi sequence DP.

    Evaluates simultaneous chord voicings, running LH/RH pitch trajectories,
    arpeggio persistence, and hand crossings without rigid pitch cutoffs.
    Deterministic and non-destructive to note timing, pitch, or velocity.
    """
    clusters = _cluster_notes_by_onset(notes)
    if not clusters:
        return [], []

    init_state = _RunningHandState(
        lh_center=_DEFAULT_LH_CENTER,
        rh_center=_DEFAULT_RH_CENTER,
        last_lh_onset=None,
        last_rh_onset=None,
        last_active="both",
    )

    all_candidates: list[list[_HandCandidate]] = [_build_candidates(c) for c in clusters]
    dp_scores: list[list[float]] = []
    dp_states: list[list[_RunningHandState]] = []
    backpointers: list[list[int]] = []

    first_cands = all_candidates[0]
    first_onset = clusters[0][0].onset_sec
    dp_scores.append([c.unary_score for c in first_cands])
    dp_states.append([_advance_state(init_state, c, first_onset) for c in first_cands])
    backpointers.append([-1] * len(first_cands))

    for t in range(1, len(clusters)):
        cur_cands = all_candidates[t]
        prev_cands = all_candidates[t - 1]
        prev_scores = dp_scores[t - 1]
        prev_states = dp_states[t - 1]
        gap_sec = max(0.0, clusters[t][0].onset_sec - clusters[t - 1][0].onset_sec)
        cur_onset = clusters[t][0].onset_sec

        cur_scores: list[float] = []
        cur_states: list[_RunningHandState] = []
        cur_bp: list[int] = []

        for cur_c in cur_cands:
            best_total = float("-inf")
            best_prev = 0
            for p_idx, prev_c in enumerate(prev_cands):
                total = (
                    prev_scores[p_idx]
                    + _transition_score(prev_states[p_idx], prev_c, cur_c, gap_sec)
                    + cur_c.unary_score
                )
                if total > best_total:
                    best_total = total
                    best_prev = p_idx
            cur_scores.append(best_total)
            cur_states.append(_advance_state(prev_states[best_prev], cur_c, cur_onset))
            cur_bp.append(best_prev)

        dp_scores.append(cur_scores)
        dp_states.append(cur_states)
        backpointers.append(cur_bp)

    chosen = [0] * len(clusters)
    last_scores = dp_scores[-1]
    chosen[-1] = max(range(len(last_scores)), key=lambda i: last_scores[i])
    for t in range(len(clusters) - 1, 0, -1):
        chosen[t - 1] = backpointers[t][chosen[t]]

    treble_notes: list[ScoreNote] = []
    bass_notes: list[ScoreNote] = []
    for t, cand_idx in enumerate(chosen):
        cand = all_candidates[t][cand_idx]
        treble_notes.extend(cand.rh_notes)
        bass_notes.extend(cand.lh_notes)

    return treble_notes, bass_notes
