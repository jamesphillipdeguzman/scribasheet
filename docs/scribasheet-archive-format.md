# ScribaSheet `.scribasheet` Portable Archive Format (`schema_version: 1`)

A `.scribasheet` file is a standard ZIP-compatible archive (`application/vnd.scribasheet.archive+zip`) designed for full offline project backup, cloud storage reclamation, and lossless project restoration.

## Internal Archive Layout

```text
<Project-Title>.scribasheet
├── manifest.json       # Archive metadata, format/schema versions, included files
├── project.json        # Complete canonical Project + ScoreData + musical/editing metadata
├── score.musicxml      # Branded editable MusicXML (omitted if project has no score)
├── score.mid           # Synthesized MIDI synced to latest score state (omitted if no score)
├── media/              # Embedded source/extracted audio or score files (optional)
│   └── 01_<filename>
└── checksums.json      # SHA-256 verification digests for every archive member
```

- Fake or empty placeholder files (`score.musicxml`, `score.mid`, `media/*`) are never written when a component is absent or excluded.
- Authentication tokens, user credentials, passwords, and unrelated account secrets are never included.

## Versioning & Migration Rules

- `manifest.schema_version`: Integer format version (`1` is current).
- `manifest.archive_format_version`: Human-readable format string (`"1.0"`).
- **Backward compatibility**: Supported older versions (`schema_version: 0`) are automatically migrated on validation/import via `migrate_archive_data(...)` in `backend/app/storage/archive_service.py`.
- **Forward safety**: Unsupported future schema versions (`schema_version > 1`) are rejected cleanly with HTTP `400`.

## Security & Integrity Safeguards

On export:
1. ZIP archive is written to a temporary file, CRC-tested (`testzip()`), checksum-verified byte-for-byte, and atomically finalized.

On validation (`POST /api/v1/archives/validate`) and import (`POST /api/v1/archives/import`):
1. Rejects non-ZIP files, files over `MAX_ARCHIVE_UPLOAD_BYTES` (`512 MB`), symlinks, duplicate paths, traversal segments (`..`, `/`, `\`, `:`), and unexpected paths outside the schema.
2. Enforces uncompressed size (`1 GB`) and compression-ratio ZIP-bomb guards.
3. Verifies every file digest against `checksums.json` (`sha256`).
4. Parses and validates MusicXML (disallowing `<!DOCTYPE` / `<!ENTITY`), MIDI (`MThd` + `pretty_midi`), canonical `ScoreData`, and embedded audio/video/PDF/MXL assets before touching the database.
5. Runs DB + storage writes transactionally with full rollback & cleanup on failure, issuing a new project ID and recording original provenance in `analysis.restored_from_archive`.

## Cloud Storage Reclamation Workflow

1. Download a `.scribasheet` archive from Dashboard or Export Center (with or without Original Audio).
2. Downloading an archive does not automatically delete the cloud project or alter cloud usage.
3. Explicitly delete the cloud project (`DELETE /api/v1/projects/{id}`) to remove unshared files from `/data/storage_data` (or R2) and reclaim persistent storage.
4. Import the `.scribasheet` archive later via Dashboard (`Import Archive (.scribasheet)`) or by dropping it onto the studio media dropzone to restore an editable copy.
