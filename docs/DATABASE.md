# ScribaSheet — Database Schema

Managed via SQLAlchemy 2.0 ORM (`backend/app/models/entities.py`) and Alembic migrations (`backend/migrations/`).

## Tables

| Table | Purpose | Key Indexes / Constraints |
|---|---|---|
| `users` | Registered accounts, password hashes, plan tier | Unique `email` |
| `projects` | User transcription projects | `(user_id, updated_at)`, `(user_id, status)`, FK `user_id` CASCADE |
| `media_assets` | Uploaded originals, stems, MIDI, MusicXML references | `(project_id, asset_type)`, FK `project_id` CASCADE |
| `transcription_jobs` | Persistent job state machine, progress, logs, settings | `(project_id, created_at)`, `(user_id, status)` |
| `transcription_results` | Links completed job to MIDI & MusicXML assets + metadata | Unique `job_id` |
| `project_scores` | Canonical editable `score_json` + latest MusicXML/MIDI paths | Unique `project_id` |
| `exports` | Generated export records (`midi`, `musicxml`, `pdf`, `wav`) | `(project_id, created_at)` |
| `usage_records` | Metered transcription minutes for server-enforced quotas | `(user_id, created_at)` |

## Running Migrations
```bash
cd backend
alembic upgrade head
```
