"""Transcription pipeline versioning and provenance helpers."""

from __future__ import annotations

import hashlib
import json
import subprocess
import uuid
from dataclasses import asdict, is_dataclass
from pathlib import Path
from typing import Any

PIPELINE_VERSION = "2.1.0"
MODEL_VERSION = "basic-pitch-0.4.0-nmp-onnx"


def compute_file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest().upper()


def compute_config_hash(config: Any) -> str:
    if is_dataclass(config) and not isinstance(config, type):
        payload = asdict(config)
    elif isinstance(config, dict):
        payload = config
    else:
        payload = {"value": str(config)}
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]


def get_git_commit_sha(repo_root: Path | None = None) -> tuple[str | None, bool | None]:
    root = repo_root or Path(__file__).resolve().parents[3]
    commit_sha: str | None = None
    dirty: bool | None = None
    try:
        res = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=str(root),
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
        if res.returncode == 0 and res.stdout.strip():
            commit_sha = res.stdout.strip()
        st = subprocess.run(
            ["git", "status", "--porcelain"],
            cwd=str(root),
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
        if st.returncode == 0:
            dirty = bool(st.stdout.strip())
    except (OSError, subprocess.SubprocessError):
        pass
    return commit_sha, dirty


def build_transcription_provenance(
    *,
    source_audio_path: Path,
    preprocessing_config: Any,
    refiner_config: Any,
    run_id: str | None = None,
    repo_root: Path | None = None,
) -> dict[str, Any]:
    commit_sha, dirty = get_git_commit_sha(repo_root)
    return {
        "run_id": run_id or uuid.uuid4().hex[:12],
        "pipeline_version": PIPELINE_VERSION,
        "model_version": MODEL_VERSION,
        "preprocessing_config_hash": compute_config_hash(preprocessing_config),
        "refiner_config_hash": compute_config_hash(refiner_config),
        "source_audio_sha256": compute_file_sha256(source_audio_path),
        "git_commit_sha": commit_sha,
        "git_dirty": dirty,
    }
