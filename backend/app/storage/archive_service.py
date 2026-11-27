"""Portable `.scribasheet` archive export, validation, migration, and transactional restore service."""

from __future__ import annotations

import hashlib
import io
import json
import logging
import os
import shutil
import tempfile
import xml.etree.ElementTree as ET
import zipfile
from copy import deepcopy
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pretty_midi
from sqlalchemy.orm import Session

from app.audio.processor import MediaValidationError, validate_upload_extension_and_mime
from app.core.config import get_settings
from app.models import MediaAsset, Project, ProjectScore, TranscriptionJob, User
from app.notation.generator import (
    apply_scribasheet_musicxml_branding,
    resolve_project_score_title,
    score_data_to_midi_bytes,
    score_data_to_musicxml,
)
from app.notation.omr import OMRError, validate_musicxml_bytes, validate_pdf_bytes
from app.schemas.score import ScoreData
from app.storage.service import (
    StorageError,
    sanitize_download_title,
    sanitize_filename,
    storage_service,
)

logger = logging.getLogger(__name__)

CURRENT_SCHEMA_VERSION = 1
SUPPORTED_SCHEMA_VERSIONS = {0, 1}
ARCHIVE_FORMAT_VERSION = "1.0"
ARCHIVE_APPLICATION = "ScribaSheet"
ARCHIVE_APPLICATION_VERSION = "1.0.0"

MAX_ARCHIVE_UPLOAD_BYTES = 512 * 1024 * 1024  # 512 MB technical request safeguard
MAX_ARCHIVE_UNCOMPRESSED_BYTES = 1024 * 1024 * 1024  # 1 GB ZIP bomb protection
MAX_ARCHIVE_MEMBER_COUNT = 200
MAX_ZIP_BOMB_RATIO = 100
_ZIP_BOMB_CHECK_MIN_SIZE = 5 * 1024 * 1024

_CORE_ARCHIVE_FILES = {
    "manifest.json",
    "project.json",
    "checksums.json",
    "score.musicxml",
    "score.mid",
}
_ALLOWED_ARCHIVE_MEDIA_TYPES = {"original", "extracted_audio"}


class ArchiveValidationError(ValueError):
    """Raised when an uploaded `.scribasheet` archive fails structure, integrity, or schema checks."""


class ArchiveExportError(RuntimeError):
    """Raised when generating or verifying a `.scribasheet` archive fails."""


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _resolve_source_type(
    project: Project,
    score_json: dict[str, Any] | None,
    media_assets: list[MediaAsset],
) -> str:
    mode = (project.transcription_mode or "").strip().lower()
    analysis = (score_json or {}).get("analysis") if isinstance(score_json, dict) else None
    if mode == "midi_playground" or (
        isinstance(analysis, dict)
        and (analysis.get("source_type") == "midi_playground" or analysis.get("mode") == "midi_playground")
    ):
        return "midi_playground"
    has_pdf_asset = any((a.original_filename or "").lower().endswith(".pdf") for a in media_assets)
    if mode == "satb_pdf" or has_pdf_asset:
        return "satb_pdf"
    if media_assets or score_json:
        return "audio_transcription"
    return "draft"


def _sanitize_transcription_settings(raw: dict[str, Any] | None) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    cleaned = deepcopy(raw)
    cleaned.pop("source_storage_key", None)
    cleaned.pop("source_media_id", None)
    return cleaned


def _extract_musicxml_metadata(xml_str: str | None) -> dict[str, Any]:
    """Extract structural & expressive notation metadata from MusicXML safely."""
    meta: dict[str, Any] = {
        "key_fifths": None,
        "key_mode": None,
        "time_signature": None,
        "pickup_beats": None,
        "measure_overrides": [],
        "repeats": [],
        "endings": [],
        "navigation_markers": [],
    }
    if not xml_str or "<score-" not in xml_str:
        return meta
    try:
        root = ET.fromstring(xml_str.lstrip("\ufeff").strip())
    except ET.ParseError:
        return meta

    first_part = root.find("part")
    if first_part is None:
        return meta

    measures = first_part.findall("measure")
    first_time_seen = False
    base_beat_type = 4
    divisions = 480

    for idx, m_el in enumerate(measures):
        m_num_raw = (m_el.get("number") or str(idx + 1)).strip()
        attr = m_el.find("attributes")
        if attr is not None:
            div_el = attr.find("divisions")
            if div_el is not None and div_el.text:
                try:
                    parsed_div = int(float(div_el.text.strip()))
                    if parsed_div > 0:
                        divisions = parsed_div
                except ValueError:
                    pass
            key_el = attr.find("key")
            if key_el is not None and meta["key_fifths"] is None:
                fifths_el = key_el.find("fifths")
                mode_el = key_el.find("mode")
                if fifths_el is not None and fifths_el.text:
                    try:
                        meta["key_fifths"] = int(fifths_el.text.strip())
                    except ValueError:
                        pass
                if mode_el is not None and mode_el.text:
                    meta["key_mode"] = mode_el.text.strip()

            time_el = attr.find("time")
            if time_el is not None:
                beats_el = time_el.find("beats")
                btype_el = time_el.find("beat-type")
                if beats_el is not None and btype_el is not None and beats_el.text and btype_el.text:
                    ts = f"{beats_el.text.strip()}/{btype_el.text.strip()}"
                    if not first_time_seen:
                        first_time_seen = True
                        meta["time_signature"] = ts
                        try:
                            base_beat_type = max(1, int(btype_el.text.strip()))
                        except ValueError:
                            base_beat_type = 4
                    else:
                        meta["measure_overrides"].append({"measure": m_num_raw, "time_signature": ts})

        if idx == 0 and (m_num_raw == "0" or (m_el.get("implicit") or "").lower() == "yes"):
            dur_total = 0
            for note_el in m_el.findall("note"):
                if note_el.find("chord") is not None:
                    continue
                if note_el.find("staff") is not None and (note_el.findtext("staff") or "1").strip() != "1":
                    continue
                d_txt = note_el.findtext("duration")
                if d_txt:
                    try:
                        dur_total += int(float(d_txt.strip()))
                    except ValueError:
                        pass
            if dur_total > 0 and divisions > 0:
                quarters = dur_total / float(divisions)
                meta["pickup_beats"] = round(quarters * (base_beat_type / 4.0), 4)

        for barline in m_el.findall("barline"):
            repeat_el = barline.find("repeat")
            if repeat_el is not None:
                entry: dict[str, Any] = {
                    "measure": m_num_raw,
                    "direction": repeat_el.get("direction"),
                }
                if repeat_el.get("times"):
                    try:
                        entry["times"] = int(repeat_el.get("times") or "2")
                    except ValueError:
                        pass
                meta["repeats"].append(entry)
            ending_el = barline.find("ending")
            if ending_el is not None:
                meta["endings"].append(
                    {
                        "measure": m_num_raw,
                        "number": ending_el.get("number"),
                        "type": ending_el.get("type"),
                    }
                )

        for direction in m_el.findall("direction"):
            dir_type = direction.find("direction-type")
            if dir_type is None:
                continue
            if dir_type.find("segno") is not None:
                meta["navigation_markers"].append({"measure": m_num_raw, "marker": "segno"})
            if dir_type.find("coda") is not None:
                meta["navigation_markers"].append({"measure": m_num_raw, "marker": "coda"})
            words_el = dir_type.find("words")
            if words_el is not None and words_el.text:
                txt = words_el.text.strip()
                if any(k in txt for k in ("D.C.", "D.S.", "To Coda", "Fine")):
                    meta["navigation_markers"].append({"measure": m_num_raw, "marker": txt})

    return meta


def _unpack_score_musicxml(score_row: ProjectScore | None, score_json: dict[str, Any] | None, resolved_title: str) -> str | None:
    """Resolve the latest editable MusicXML text from stored XML/MXL or canonical ScoreData."""
    raw_xml: str | None = None
    if score_row and score_row.musicxml_path and storage_service.exists(score_row.musicxml_path):
        try:
            raw_bytes = storage_service.read_bytes(score_row.musicxml_path)
            if score_row.musicxml_path.lower().endswith(".mxl") or raw_bytes[:2] == b"PK":
                with zipfile.ZipFile(io.BytesIO(raw_bytes), "r") as zf:
                    xml_name = next(
                        (
                            n
                            for n in zf.namelist()
                            if n.lower().endswith((".xml", ".musicxml")) and "meta-inf" not in n.lower()
                        ),
                        None,
                    )
                    if xml_name:
                        raw_xml = zf.read(xml_name).decode("utf-8-sig", errors="replace")
            else:
                raw_xml = raw_bytes.decode("utf-8-sig", errors="replace")
        except Exception as exc:
            logger.warning("Could not read MusicXML path '%s' directly: %s", score_row.musicxml_path, exc)
            raw_xml = None

    if (not raw_xml or "<score-" not in raw_xml) and isinstance(score_json, dict) and score_json:
        try:
            raw_xml = score_data_to_musicxml(ScoreData(**score_json))
        except Exception:
            raw_xml = None

    if not raw_xml or "<score-" not in raw_xml:
        return None
    return apply_scribasheet_musicxml_branding(raw_xml, title=resolved_title, force_title=True)


def get_project_archive_summary(
    db: Session,
    project: Project,
    *,
    include_audio: bool = True,
) -> dict[str, Any]:
    """Return accurate pre-export summary for Dashboard and Export Center."""
    score_row = db.query(ProjectScore).filter(ProjectScore.project_id == project.id).first()
    media_rows = (
        db.query(MediaAsset)
        .filter(
            MediaAsset.project_id == project.id,
            MediaAsset.asset_type.in_(tuple(_ALLOWED_ARCHIVE_MEDIA_TYPES)),
        )
        .order_by(MediaAsset.created_at.asc())
        .all()
    )

    available_media: list[dict[str, Any]] = []
    available_bytes = 0
    for asset in media_rows:
        if not asset.storage_path or not storage_service.exists(asset.storage_path):
            continue
        actual_size = storage_service.get_object_size(asset.storage_path)
        sz = int(actual_size if actual_size is not None else (asset.size_bytes or 0))
        available_bytes += sz
        available_media.append(
            {
                "filename": asset.original_filename,
                "asset_type": asset.asset_type,
                "mime_type": asset.mime_type,
                "size_bytes": sz,
            }
        )

    score_json = dict(score_row.score_json or {}) if score_row else None
    has_score = bool(score_row is not None and (score_json or score_row.musicxml_path or score_row.midi_path))
    included_media_files = available_media if include_audio else []
    included_bytes = available_bytes if include_audio else 0

    return {
        "project_id": project.id,
        "title": project.title,
        "source_type": _resolve_source_type(project, score_json, media_rows),
        "has_score": has_score,
        "include_audio": include_audio,
        "available_media_count": len(available_media),
        "included_media_count": len(included_media_files),
        "available_media_bytes": available_bytes,
        "included_media_bytes": included_bytes,
        "media_files": included_media_files,
    }


def build_project_archive(
    db: Session,
    project: Project,
    *,
    include_audio: bool = True,
) -> tuple[Path, Path, str, dict[str, Any]]:
    """Build and verify a portable `.scribasheet` ZIP archive from latest canonical state."""
    tmp_dir = Path(tempfile.mkdtemp(prefix="scriba_archive_export_"))
    try:
        resolved_title = resolve_project_score_title(project.title)
        score_row = db.query(ProjectScore).filter(ProjectScore.project_id == project.id).first()
        score_json = deepcopy(score_row.score_json) if (score_row and isinstance(score_row.score_json, dict)) else None
        if score_json is not None:
            score_json["title"] = resolved_title

        media_rows = (
            db.query(MediaAsset)
            .filter(
                MediaAsset.project_id == project.id,
                MediaAsset.asset_type.in_(tuple(_ALLOWED_ARCHIVE_MEDIA_TYPES)),
            )
            .order_by(MediaAsset.created_at.asc())
            .all()
        )
        latest_job = (
            db.query(TranscriptionJob)
            .filter(TranscriptionJob.project_id == project.id)
            .order_by(TranscriptionJob.created_at.desc())
            .first()
        )

        members: dict[str, bytes] = {}
        media_descriptors: list[dict[str, Any]] = []

        musicxml_str = _unpack_score_musicxml(score_row, score_json, resolved_title)
        if musicxml_str:
            members["score.musicxml"] = musicxml_str.encode("utf-8")

        # Generate MIDI from latest canonical ScoreData so MIDI never conflicts with edited score state.
        midi_bytes: bytes | None = None
        if score_json is not None:
            try:
                midi_bytes = score_data_to_midi_bytes(ScoreData(**score_json))
            except Exception as exc:
                logger.warning("Failed to synthesize archive MIDI from score_json: %s", exc)
        if midi_bytes is None and score_row and score_row.midi_path and storage_service.exists(score_row.midi_path):
            midi_bytes = storage_service.read_bytes(score_row.midi_path)
        if midi_bytes:
            members["score.mid"] = midi_bytes

        if include_audio:
            used_archive_names: set[str] = set()
            for idx, asset in enumerate(media_rows, start=1):
                if not asset.storage_path or not storage_service.exists(asset.storage_path):
                    continue
                payload = storage_service.read_bytes(asset.storage_path)
                if not payload:
                    continue
                safe_orig = sanitize_filename(asset.original_filename or f"media_{idx}.bin")
                archive_name = f"media/{idx:02d}_{safe_orig}"
                while archive_name in used_archive_names:
                    archive_name = f"media/{idx:02d}_{len(used_archive_names)}_{safe_orig}"
                used_archive_names.add(archive_name)
                members[archive_name] = payload
                media_descriptors.append(
                    {
                        "archive_path": archive_name,
                        "asset_type": asset.asset_type,
                        "original_filename": asset.original_filename,
                        "mime_type": asset.mime_type,
                        "size_bytes": len(payload),
                        "duration_seconds": asset.duration_seconds,
                        "sample_rate": asset.sample_rate,
                        "channels": asset.channels,
                    }
                )

        source_type = _resolve_source_type(project, score_json, media_rows)
        has_original_in_cloud = any(a.asset_type == "original" for a in media_rows)
        original_audio_omitted = (not include_audio) and has_original_in_cloud
        xml_meta = _extract_musicxml_metadata(musicxml_str)
        analysis = score_json.get("analysis") if isinstance(score_json, dict) else {}
        if not isinstance(analysis, dict):
            analysis = {}

        project_doc: dict[str, Any] = {
            "schema_version": CURRENT_SCHEMA_VERSION,
            "provenance": {
                "original_project_id": project.id,
                "exported_at": datetime.now(UTC).isoformat(),
                "source_type": source_type,
            },
            "project": {
                "title": project.title,
                "description": project.description or "",
                "status": project.status,
                "instrument": project.instrument,
                "transcription_mode": project.transcription_mode,
                "duration_seconds": project.duration_seconds,
                "created_at": project.created_at.isoformat() if project.created_at else None,
                "updated_at": project.updated_at.isoformat() if project.updated_at else None,
            },
            "musical_metadata": {
                "tempo_bpm": (score_json or {}).get("tempo_bpm"),
                "tempo_estimated": (score_json or {}).get("tempo_estimated"),
                "time_signature": (score_json or {}).get("time_signature") or xml_meta.get("time_signature"),
                "time_signature_estimated": (score_json or {}).get("time_signature_estimated"),
                "key_signature": (score_json or {}).get("key_signature"),
                "key_signature_estimated": (score_json or {}).get("key_signature_estimated"),
                "key_fifths": xml_meta.get("key_fifths"),
                "key_mode": xml_meta.get("key_mode"),
                "pickup_beats": analysis.get("pickup_beats") if analysis.get("pickup_beats") is not None else xml_meta.get("pickup_beats"),
                "clef_mode": analysis.get("clef_mode"),
                "arrangement_detail": analysis.get("arrangement_detail"),
                "playability_smoothing": analysis.get("playability_smoothing"),
                "quantization": analysis.get("quantization"),
                "measure_overrides": xml_meta.get("measure_overrides") or [],
                "repeats": xml_meta.get("repeats") or [],
                "endings": xml_meta.get("endings") or [],
                "navigation_markers": xml_meta.get("navigation_markers") or [],
            },
            "score": {
                "has_score": score_row is not None,
                "version": int(score_row.version) if score_row else 0,
                "has_musicxml": "score.musicxml" in members,
                "has_midi": "score.mid" in members,
                "score_json": score_json,
            },
            "lyrics": analysis.get("lyrics") if isinstance(analysis.get("lyrics"), dict) else None,
            "transcription_settings": _sanitize_transcription_settings(
                latest_job.settings_json if latest_job else None
            ),
            "media": media_descriptors,
            "original_audio_omitted": original_audio_omitted,
        }
        members["project.json"] = json.dumps(project_doc, indent=2, ensure_ascii=False).encode("utf-8")

        exported_at = datetime.now(UTC).isoformat()
        included_files = sorted([*members.keys(), "manifest.json", "checksums.json"])
        manifest_doc: dict[str, Any] = {
            "schema_version": CURRENT_SCHEMA_VERSION,
            "archive_format_version": ARCHIVE_FORMAT_VERSION,
            "application": ARCHIVE_APPLICATION,
            "application_version": ARCHIVE_APPLICATION_VERSION,
            "exported_at": exported_at,
            "project_id": project.id,
            "title": project.title,
            "source_type": source_type,
            "has_score": score_row is not None,
            "included_media": len(media_descriptors) > 0,
            "include_audio_requested": include_audio,
            "original_audio_omitted": original_audio_omitted,
            "media_count": len(media_descriptors),
            "included_files": included_files,
        }
        members["manifest.json"] = json.dumps(manifest_doc, indent=2, ensure_ascii=False).encode("utf-8")

        checksums_map = {name: _sha256_bytes(payload) for name, payload in sorted(members.items())}
        checksums_doc = {"algorithm": "sha256", "files": checksums_map}
        members["checksums.json"] = json.dumps(checksums_doc, indent=2, ensure_ascii=False).encode("utf-8")

        tmp_zip = tmp_dir / "archive.tmp.zip"
        with zipfile.ZipFile(tmp_zip, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            for name in sorted(members.keys()):
                zf.writestr(name, members[name])

        # Verify archive readability, required entries, and SHA-256 integrity before atomic finalize.
        with zipfile.ZipFile(tmp_zip, "r") as zf:
            bad_member = zf.testzip()
            if bad_member is not None:
                raise ArchiveExportError(f"Generated archive failed ZIP CRC verification at '{bad_member}'.")
            present = set(zf.namelist())
            for req in ("manifest.json", "project.json", "checksums.json"):
                if req not in present:
                    raise ArchiveExportError(f"Generated archive missing required member '{req}'.")
            for name, expected_hash in checksums_map.items():
                if _sha256_bytes(zf.read(name)) != expected_hash:
                    raise ArchiveExportError(f"Checksum mismatch after writing '{name}'.")

        safe_title = sanitize_download_title(project.title, fallback="ScribaSheet-Project").replace(" ", "-")
        download_name = f"{safe_title}.scribasheet"
        final_path = tmp_dir / download_name
        os.replace(tmp_zip, final_path)
        return tmp_dir, final_path, download_name, manifest_doc
    except StorageError:
        shutil.rmtree(tmp_dir, ignore_errors=True)
        raise
    except ArchiveExportError:
        shutil.rmtree(tmp_dir, ignore_errors=True)
        raise
    except Exception as exc:
        shutil.rmtree(tmp_dir, ignore_errors=True)
        logger.exception("Archive generation failed for project %s: %s", project.id, exc)
        raise ArchiveExportError(f"Failed to generate .scribasheet archive: {exc}") from exc


def migrate_archive_data(
    manifest: dict[str, Any],
    project_data: dict[str, Any],
) -> tuple[dict[str, Any], dict[str, Any], list[str]]:
    """Validate schema_version and migrate supported legacy archives into schema v1."""
    warnings: list[str] = []
    raw_version = manifest.get("schema_version")
    if isinstance(raw_version, bool) or not isinstance(raw_version, int):
        raise ArchiveValidationError("Archive manifest is missing a valid integer schema_version.")

    if raw_version > CURRENT_SCHEMA_VERSION:
        raise ArchiveValidationError(
            f"Unsupported archive schema_version {raw_version}. This ScribaSheet version supports up to schema v{CURRENT_SCHEMA_VERSION}."
        )
    if raw_version not in SUPPORTED_SCHEMA_VERSIONS:
        raise ArchiveValidationError(f"Unsupported archive schema_version {raw_version}.")

    if raw_version == 0:
        migrated_manifest = deepcopy(manifest)
        migrated_manifest["schema_version"] = CURRENT_SCHEMA_VERSION
        migrated_project: dict[str, Any] = {
            "schema_version": CURRENT_SCHEMA_VERSION,
            "provenance": {
                "original_project_id": project_data.get("project_id") or manifest.get("project_id"),
                "exported_at": manifest.get("exported_at"),
                "source_type": project_data.get("source_type") or manifest.get("source_type") or "audio_transcription",
                "migrated_from_schema_version": 0,
            },
            "project": deepcopy(project_data.get("project"))
            if isinstance(project_data.get("project"), dict)
            else {
                "title": project_data.get("title") or manifest.get("title") or "Restored Project",
                "description": project_data.get("description") or "",
                "status": "ready",
                "instrument": project_data.get("instrument") or "piano",
                "transcription_mode": project_data.get("transcription_mode") or "polyphonic",
                "duration_seconds": project_data.get("duration_seconds"),
            },
            "musical_metadata": deepcopy(project_data.get("musical_metadata"))
            if isinstance(project_data.get("musical_metadata"), dict)
            else {
                "tempo_bpm": project_data.get("tempo_bpm"),
                "time_signature": project_data.get("time_signature"),
                "key_signature": project_data.get("key_signature"),
                "pickup_beats": project_data.get("pickup_beats"),
            },
            "score": deepcopy(project_data.get("score"))
            if isinstance(project_data.get("score"), dict)
            else {
                "has_score": isinstance(project_data.get("score_json") or project_data.get("score_data"), dict),
                "version": 1,
                "score_json": deepcopy(project_data.get("score_json") or project_data.get("score_data")),
            },
            "lyrics": project_data.get("lyrics"),
            "transcription_settings": project_data.get("transcription_settings"),
            "media": project_data.get("media") if isinstance(project_data.get("media"), list) else [],
            "original_audio_omitted": bool(project_data.get("original_audio_omitted", False)),
        }
        warnings.append("Migrated archive metadata from schema_version 0 to schema_version 1.")
        return migrated_manifest, migrated_project, warnings

    return manifest, project_data, warnings


def _assert_safe_archive_member_path(name: str) -> None:
    if not name or "\x00" in name or "\\" in name or name.startswith("/") or ":" in name:
        raise ArchiveValidationError(f"Unsafe path in archive: '{name}'.")
    parts = name.split("/")
    if any(p in ("", ".", "..") for p in parts):
        raise ArchiveValidationError(f"Invalid path traversal segment in archive: '{name}'.")
    if name in _CORE_ARCHIVE_FILES:
        return
    if len(parts) == 2 and parts[0] == "media" and parts[1]:
        return
    raise ArchiveValidationError(f"Unexpected file path '{name}' in .scribasheet archive.")


def validate_archive_file(archive_path: Path) -> dict[str, Any]:
    """Validate structure, safety, checksums, MusicXML/MIDI, and media of a `.scribasheet` file."""
    if not archive_path.exists():
        raise ArchiveValidationError("Uploaded archive file does not exist.")
    archive_size = archive_path.stat().st_size
    if archive_size <= 0:
        raise ArchiveValidationError("Archive file is empty.")
    if archive_size > MAX_ARCHIVE_UPLOAD_BYTES:
        raise ArchiveValidationError(
            f"Archive exceeds maximum allowed size of {MAX_ARCHIVE_UPLOAD_BYTES // (1024 * 1024)} MB."
        )
    if not zipfile.is_zipfile(archive_path):
        raise ArchiveValidationError("File is not a valid .scribasheet ZIP archive.")

    settings = get_settings()
    try:
        with zipfile.ZipFile(archive_path, "r") as zf:
            infos = zf.infolist()
            if len(infos) > MAX_ARCHIVE_MEMBER_COUNT:
                raise ArchiveValidationError("Archive contains too many entries.")

            seen_names: set[str] = set()
            total_uncompressed = 0
            for info in infos:
                mode_bits = (info.external_attr >> 16) & 0o170000
                if mode_bits == 0o120000:
                    raise ArchiveValidationError(f"Symbolic links are not permitted in archive: '{info.filename}'.")
                if info.is_dir():
                    raise ArchiveValidationError(f"Unexpected directory entry '{info.filename}' in archive.")
                if info.filename in seen_names:
                    raise ArchiveValidationError(f"Duplicate entry '{info.filename}' in archive.")
                seen_names.add(info.filename)
                _assert_safe_archive_member_path(info.filename)

                if info.file_size < 0:
                    raise ArchiveValidationError("Invalid negative file size in archive.")
                total_uncompressed += info.file_size
                if total_uncompressed > MAX_ARCHIVE_UNCOMPRESSED_BYTES:
                    raise ArchiveValidationError("Archive uncompressed size exceeds security limit.")
                if info.file_size > _ZIP_BOMB_CHECK_MIN_SIZE:
                    ratio = info.file_size / max(1, info.compress_size)
                    if ratio > MAX_ZIP_BOMB_RATIO:
                        raise ArchiveValidationError("Archive failed compression ratio security check.")

            for required in ("manifest.json", "project.json", "checksums.json"):
                if required not in seen_names:
                    raise ArchiveValidationError(f"Archive is missing required file '{required}'.")

            try:
                manifest_raw = json.loads(zf.read("manifest.json").decode("utf-8"))
                project_raw = json.loads(zf.read("project.json").decode("utf-8"))
                checksums_raw = json.loads(zf.read("checksums.json").decode("utf-8"))
            except Exception as exc:
                raise ArchiveValidationError(f"Corrupted JSON metadata inside archive: {exc}") from exc

            if not isinstance(manifest_raw, dict) or not isinstance(project_raw, dict) or not isinstance(checksums_raw, dict):
                raise ArchiveValidationError("Archive metadata files must be JSON objects.")

            if manifest_raw.get("application") != ARCHIVE_APPLICATION:
                raise ArchiveValidationError("Archive was not created by ScribaSheet.")

            if checksums_raw.get("algorithm") != "sha256" or not isinstance(checksums_raw.get("files"), dict):
                raise ArchiveValidationError("Archive checksums.json must use sha256 algorithm.")

            expected_files_map = checksums_raw["files"]
            non_checksum_members = {n for n in seen_names if n != "checksums.json"}
            if set(expected_files_map.keys()) != non_checksum_members:
                raise ArchiveValidationError("Archive file list does not match checksums.json manifest.")

            for member_name in sorted(non_checksum_members):
                expected_digest = expected_files_map[member_name]
                actual_digest = _sha256_bytes(zf.read(member_name))
                if not isinstance(expected_digest, str) or actual_digest != expected_digest.lower():
                    raise ArchiveValidationError(f"Checksum verification failed for '{member_name}'.")

            manifest, project_data, warnings = migrate_archive_data(manifest_raw, project_raw)

            score_meta = project_data.get("score") if isinstance(project_data.get("score"), dict) else {}
            musicxml_str: str | None = None
            if "score.musicxml" in seen_names:
                xml_bytes = zf.read("score.musicxml")
                xml_text = xml_bytes.decode("utf-8-sig", errors="replace").strip()
                if "<!DOCTYPE" in xml_text.upper() or "<!ENTITY" in xml_text.upper():
                    raise ArchiveValidationError("MusicXML payload contains forbidden DTD/ENTITY declarations.")
                try:
                    xml_root = ET.fromstring(xml_text)
                except ET.ParseError as exc:
                    raise ArchiveValidationError(f"Corrupted MusicXML inside archive: {exc}") from exc
                if xml_root.tag not in ("score-partwise", "score-timewise"):
                    raise ArchiveValidationError("Archive score.musicxml has invalid MusicXML root element.")
                musicxml_str = xml_text

            score_json_raw = score_meta.get("score_json")
            validated_score: ScoreData | None = None
            if isinstance(score_json_raw, dict):
                try:
                    validated_score = ScoreData(**score_json_raw)
                except Exception as exc:
                    raise ArchiveValidationError(f"Invalid canonical score data in project.json: {exc}") from exc

            has_score = bool(score_meta.get("has_score") or manifest.get("has_score"))
            if has_score and musicxml_str is None and validated_score is None:
                raise ArchiveValidationError("Archive declares a score but contains neither MusicXML nor score_json.")

            midi_bytes: bytes | None = None
            if "score.mid" in seen_names:
                midi_bytes = zf.read("score.mid")
                if not midi_bytes.startswith(b"MThd"):
                    raise ArchiveValidationError("Archive score.mid is not a valid MIDI file.")
                try:
                    pretty_midi.PrettyMIDI(io.BytesIO(midi_bytes))
                except Exception as exc:
                    raise ArchiveValidationError(f"Archive score.mid could not be parsed: {exc}") from exc

            # Validate embedded media descriptors & file payloads
            media_descriptors = project_data.get("media") if isinstance(project_data.get("media"), list) else []
            descriptor_by_path: dict[str, dict[str, Any]] = {}
            for item in media_descriptors:
                if not isinstance(item, dict) or not isinstance(item.get("archive_path"), str):
                    raise ArchiveValidationError("Malformed media descriptor in project.json.")
                ap = item["archive_path"]
                _assert_safe_archive_member_path(ap)
                if ap not in seen_names:
                    raise ArchiveValidationError(f"Missing media file '{ap}' referenced by project.json.")
                descriptor_by_path[ap] = item

            media_members = sorted(n for n in seen_names if n.startswith("media/"))
            validated_media: list[dict[str, Any]] = []
            for ap in media_members:
                desc = descriptor_by_path.get(ap)
                if desc is None:
                    raise ArchiveValidationError(f"Unindexed media file '{ap}' found inside archive.")
                raw_media = zf.read(ap)
                if len(raw_media) == 0:
                    raise ArchiveValidationError(f"Embedded media file '{ap}' is empty.")
                if len(raw_media) > settings.max_upload_bytes:
                    raise ArchiveValidationError(
                        f"Embedded media file '{ap}' exceeds maximum upload file size ({settings.MAX_UPLOAD_SIZE_MB} MB)."
                    )
                orig_name = sanitize_filename(str(desc.get("original_filename") or Path(ap).name))
                mime_type = str(desc.get("mime_type") or "application/octet-stream")
                asset_type = str(desc.get("asset_type") or "original")
                if asset_type not in _ALLOWED_ARCHIVE_MEDIA_TYPES:
                    raise ArchiveValidationError(f"Unsupported media asset_type '{asset_type}'.")

                lower_name = orig_name.lower()
                if lower_name.endswith(".pdf"):
                    try:
                        validate_pdf_bytes(raw_media)
                    except OMRError as exc:
                        raise ArchiveValidationError(f"Invalid embedded PDF '{orig_name}': {exc.message}") from exc
                elif lower_name.endswith((".mxl", ".musicxml")):
                    try:
                        validate_musicxml_bytes(raw_media, orig_name)
                    except OMRError as exc:
                        raise ArchiveValidationError(f"Invalid embedded score '{orig_name}': {exc.message}") from exc
                else:
                    try:
                        validate_upload_extension_and_mime(orig_name, mime_type)
                    except MediaValidationError as exc:
                        raise ArchiveValidationError(f"Unsupported embedded media '{orig_name}': {exc.message}") from exc

                validated_media.append(
                    {
                        "archive_path": ap,
                        "asset_type": asset_type,
                        "original_filename": orig_name,
                        "mime_type": mime_type,
                        "size_bytes": len(raw_media),
                        "duration_seconds": desc.get("duration_seconds"),
                        "sample_rate": desc.get("sample_rate"),
                        "channels": desc.get("channels"),
                        "bytes": raw_media,
                    }
                )

            proj_info = project_data.get("project") if isinstance(project_data.get("project"), dict) else {}
            musical_meta = project_data.get("musical_metadata") if isinstance(project_data.get("musical_metadata"), dict) else {}
            lyrics_data = project_data.get("lyrics") if isinstance(project_data.get("lyrics"), dict) else None
            title = str(proj_info.get("title") or manifest.get("title") or "Restored Project").strip() or "Restored Project"

            preview = {
                "valid": True,
                "schema_version": manifest.get("schema_version"),
                "archive_format_version": manifest.get("archive_format_version"),
                "exported_at": manifest.get("exported_at"),
                "original_project_id": (project_data.get("provenance") or {}).get("original_project_id") or manifest.get("project_id"),
                "title": title[:200],
                "source_type": manifest.get("source_type") or "audio_transcription",
                "has_score": has_score or bool(musicxml_str or validated_score),
                "included_media": len(validated_media) > 0,
                "original_audio_omitted": bool(project_data.get("original_audio_omitted", False)),
                "media_count": len(validated_media),
                "total_media_bytes": sum(m["size_bytes"] for m in validated_media),
                "included_files": sorted(seen_names),
                "tempo_bpm": validated_score.tempo_bpm if validated_score else musical_meta.get("tempo_bpm"),
                "time_signature": validated_score.time_signature if validated_score else musical_meta.get("time_signature"),
                "key_signature": validated_score.key_signature if validated_score else musical_meta.get("key_signature"),
                "note_count": len(validated_score.notes) if validated_score else 0,
                "chord_count": len(validated_score.chords) if validated_score else 0,
                "has_lyrics": bool(lyrics_data and (lyrics_data.get("text") or lyrics_data.get("segments"))),
                "checksums_verified": True,
                "warnings": warnings,
            }

            return {
                "preview": preview,
                "manifest": manifest,
                "project_data": project_data,
                "validated_score": validated_score,
                "musicxml_str": musicxml_str,
                "midi_bytes": midi_bytes,
                "validated_media": validated_media,
            }
    except zipfile.BadZipFile as exc:
        raise ArchiveValidationError("Corrupted or invalid .scribasheet ZIP file.") from exc


def restore_project_from_archive(db: Session, user: User, archive_path: Path) -> Project:
    """Validate and transactionally restore a `.scribasheet` archive into a new owned project."""
    bundle = validate_archive_file(archive_path)
    preview = bundle["preview"]
    manifest = bundle["manifest"]
    project_data = bundle["project_data"]
    proj_info = project_data.get("project") if isinstance(project_data.get("project"), dict) else {}
    musical_meta = project_data.get("musical_metadata") if isinstance(project_data.get("musical_metadata"), dict) else {}
    lyrics_data = project_data.get("lyrics") if isinstance(project_data.get("lyrics"), dict) else None
    validated_score: ScoreData | None = bundle["validated_score"]
    musicxml_str: str | None = bundle["musicxml_str"]
    midi_bytes: bytes | None = bundle["midi_bytes"]
    validated_media: list[dict[str, Any]] = bundle["validated_media"]

    project = Project(
        user_id=user.id,
        title=str(preview["title"])[:200],
        description=str(proj_info.get("description") or ""),
        instrument=str(proj_info.get("instrument") or "piano")[:64],
        transcription_mode=str(proj_info.get("transcription_mode") or "polyphonic")[:64],
        duration_seconds=proj_info.get("duration_seconds"),
        status="restoring",
    )
    db.add(project)
    db.flush()

    written_keys: list[str] = []
    try:
        has_restored_score = bool(validated_score is not None or musicxml_str is not None)
        if has_restored_score:
            resolved_title = resolve_project_score_title(project.title)
            if validated_score is not None:
                score_dict = validated_score.model_dump()
            else:
                score_dict = ScoreData(
                    title=resolved_title,
                    tempo_bpm=float(musical_meta.get("tempo_bpm") or 120.0),
                    time_signature=str(musical_meta.get("time_signature") or "4/4"),
                    key_signature=str(musical_meta.get("key_signature") or "C"),
                    duration_seconds=float(project.duration_seconds or 0.0),
                ).model_dump()

            score_dict["title"] = resolved_title
            analysis = dict(score_dict.get("analysis") or {})
            analysis["is_active"] = True
            if lyrics_data and not isinstance(analysis.get("lyrics"), dict):
                analysis["lyrics"] = deepcopy(lyrics_data)
            analysis["restored_from_archive"] = {
                "original_project_id": preview.get("original_project_id"),
                "exported_at": manifest.get("exported_at"),
                "schema_version": manifest.get("schema_version"),
                "original_audio_omitted": preview.get("original_audio_omitted", False),
            }
            score_dict["analysis"] = analysis

            final_xml = musicxml_str or score_data_to_musicxml(ScoreData(**score_dict))
            final_xml = apply_scribasheet_musicxml_branding(final_xml, title=resolved_title, force_title=True)
            xml_key = storage_service.build_key(user.id, project.id, "musicxml", "score.musicxml")
            storage_service.save_bytes(
                xml_key,
                final_xml.encode("utf-8"),
                content_type="application/vnd.recordare.musicxml+xml",
            )
            written_keys.append(xml_key)

            final_midi = midi_bytes or score_data_to_midi_bytes(ScoreData(**score_dict))
            midi_key = storage_service.build_key(user.id, project.id, "midi", "score.mid")
            storage_service.save_bytes(midi_key, final_midi, content_type="audio/midi")
            written_keys.append(midi_key)

            db.add(
                ProjectScore(
                    project_id=project.id,
                    version=1,
                    score_json=score_dict,
                    musicxml_path=xml_key,
                    midi_path=midi_key,
                )
            )

        for media in validated_media:
            category = "extracted/restored" if media["asset_type"] == "extracted_audio" else "originals"
            m_key = storage_service.build_key(user.id, project.id, category, media["original_filename"])
            storage_service.save_bytes(m_key, media["bytes"], content_type=media["mime_type"])
            written_keys.append(m_key)
            db.add(
                MediaAsset(
                    project_id=project.id,
                    user_id=user.id,
                    asset_type=media["asset_type"],
                    storage_path=m_key,
                    original_filename=media["original_filename"],
                    mime_type=media["mime_type"],
                    size_bytes=media["size_bytes"],
                    duration_seconds=media["duration_seconds"],
                    sample_rate=media["sample_rate"],
                    channels=media["channels"],
                )
            )

        project.status = "ready" if has_restored_score else "draft"
        db.commit()
        db.refresh(project)
        return project
    except Exception:
        db.rollback()
        for key in written_keys:
            try:
                storage_service.delete(key)
            except Exception:
                pass
        raise
