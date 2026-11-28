from datetime import UTC, datetime
import hmac
import re
import secrets
import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.db.session import get_db
from app.models import User, UserPlaylist
from app.schemas.playlists import (
    PlayerPreferencesSchema,
    PlaylistCategorySchema,
    PlaylistCreateRequest,
    PlaylistItemSchema,
    PlaylistLibraryResponse,
    PlaylistLibrarySyncRequest,
    PlaylistShareStatusResponse,
    PlaylistUpdateRequest,
    PublicSharedPlaylistResponse,
    PublicSharedTrackSchema,
    TrackLoopMarkersSchema,
)

router = APIRouter(prefix="/playlists", tags=["Playlists"])

META_RECORD_TYPE = "library_meta"
PLAYLIST_RECORD_TYPE = "playlist"
SHARE_TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{20,96}$")

DEFAULT_CATEGORY_NAMES = {
    "cat-classical-violin": "Classical Violin",
    "cat-choral-satb": "Choral / SATB",
    "cat-piano-arrangements": "Piano Arrangements",
    "cat-practice-reference": "Practice / Reference",
    "cat-sight-reading": "Sight-Reading",
}


def _utc_iso(dt: datetime | None = None) -> str:
    val = dt or datetime.now(UTC)
    return val.isoformat().replace("+00:00", "Z")


def _generate_share_token() -> str:
    return secrets.token_urlsafe(32)


def _row_to_playlist_item(row: UserPlaylist) -> PlaylistItemSchema:
    return PlaylistItemSchema(
        id=row.client_id,
        serverId=row.id,
        title=row.title,
        description=row.description or "",
        categoryId=row.category_id,
        tracks=row.tracks_json or [],
        isShared=bool(row.is_shared and row.share_token),
        shareToken=row.share_token if row.is_shared else None,
        sharedAt=_utc_iso(row.shared_at) if row.is_shared and row.shared_at else None,
        createdAt=_utc_iso(row.created_at),
        updatedAt=_utc_iso(row.updated_at),
    )


def _row_to_share_status(row: UserPlaylist) -> PlaylistShareStatusResponse:
    shared = bool(row.is_shared and row.share_token)
    return PlaylistShareStatusResponse(
        playlistId=row.client_id,
        serverId=row.id,
        isShared=shared,
        shareToken=row.share_token if shared else None,
        sharedAt=_utc_iso(row.shared_at) if shared and row.shared_at else None,
    )


def _resolve_category_name(db: Session, user_id: str, category_id: str) -> str:
    if category_id in DEFAULT_CATEGORY_NAMES:
        return DEFAULT_CATEGORY_NAMES[category_id]
    meta_row = (
        db.query(UserPlaylist)
        .filter(UserPlaylist.user_id == user_id, UserPlaylist.record_type == META_RECORD_TYPE)
        .first()
    )
    if meta_row and isinstance(meta_row.metadata_json, dict):
        for cat in meta_row.metadata_json.get("categories") or []:
            if isinstance(cat, dict) and cat.get("id") == category_id:
                name = str(cat.get("name") or "").strip()
                if name:
                    return name
    return "Practice / Reference"


def _find_playlist_row(db: Session, playlist_id: str, user_id: str) -> UserPlaylist:
    row = (
        db.query(UserPlaylist)
        .filter(UserPlaylist.record_type == PLAYLIST_RECORD_TYPE, UserPlaylist.id == playlist_id)
        .first()
    )
    if row is None:
        row = (
            db.query(UserPlaylist)
            .filter(
                UserPlaylist.record_type == PLAYLIST_RECORD_TYPE,
                UserPlaylist.user_id == user_id,
                UserPlaylist.client_id == playlist_id,
            )
            .first()
        )
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Playlist not found.")
    if row.user_id != user_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You do not have access to this playlist.")
    return row


def _handle_storage_unavailable(exc: SQLAlchemyError) -> None:
    raise HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail=f"Playlist database storage unavailable; continuing in local mode ({exc.__class__.__name__}).",
    )


@router.get("", response_model=PlaylistLibraryResponse)
def get_playlist_library(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    try:
        rows = (
            db.query(UserPlaylist)
            .filter(UserPlaylist.user_id == current_user.id)
            .order_by(UserPlaylist.position.asc(), UserPlaylist.created_at.asc())
            .all()
        )
    except SQLAlchemyError as exc:
        _handle_storage_unavailable(exc)
        raise  # pragma: no cover

    meta_row = next((r for r in rows if r.record_type == META_RECORD_TYPE), None)
    playlist_rows = [r for r in rows if r.record_type == PLAYLIST_RECORD_TYPE]

    meta_json = (meta_row.metadata_json if meta_row else None) or {}
    raw_categories = meta_json.get("categories") or []
    raw_preferences = meta_json.get("preferences") or {}

    categories = [PlaylistCategorySchema.model_validate(c) for c in raw_categories]
    preferences = PlayerPreferencesSchema.model_validate(raw_preferences)
    playlists = [_row_to_playlist_item(r) for r in playlist_rows]
    latest_dt = max((r.updated_at for r in rows), default=None)

    return PlaylistLibraryResponse(
        schemaVersion=1,
        updatedAt=_utc_iso(latest_dt),
        categories=categories,
        playlists=playlists,
        preferences=preferences,
    )


@router.put("/sync", response_model=PlaylistLibraryResponse)
def sync_playlist_library(
    payload: PlaylistLibrarySyncRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    try:
        existing_rows = (
            db.query(UserPlaylist)
            .filter(UserPlaylist.user_id == current_user.id)
            .all()
        )
        now = datetime.now(UTC)

        meta_row = next((r for r in existing_rows if r.record_type == META_RECORD_TYPE), None)
        meta_payload = {
            "categories": [c.model_dump() for c in payload.categories],
            "preferences": payload.preferences.model_dump(),
            "schemaVersion": payload.schemaVersion,
        }
        if meta_row is None:
            meta_row = UserPlaylist(
                id=str(uuid.uuid4()),
                user_id=current_user.id,
                record_type=META_RECORD_TYPE,
                client_id="library_meta",
                title="Library Metadata",
                description="",
                category_id="meta",
                position=0,
                tracks_json=[],
                metadata_json=meta_payload,
                is_shared=False,
                share_token=None,
                shared_at=None,
                created_at=now,
                updated_at=now,
            )
            db.add(meta_row)
        else:
            meta_row.metadata_json = meta_payload
            meta_row.updated_at = now

        existing_by_client = {
            r.client_id: r for r in existing_rows if r.record_type == PLAYLIST_RECORD_TYPE
        }
        incoming_client_ids: set[str] = set()
        saved_rows: list[UserPlaylist] = []

        for idx, pl in enumerate(payload.playlists):
            cid = pl.id.strip()
            if cid in incoming_client_ids:
                continue
            incoming_client_ids.add(cid)
            serialized_tracks = [t.model_dump() for t in pl.tracks]
            row = existing_by_client.get(cid)
            if row is None:
                # New playlists ALWAYS start private regardless of client payload
                row = UserPlaylist(
                    id=str(uuid.uuid4()),
                    user_id=current_user.id,
                    record_type=PLAYLIST_RECORD_TYPE,
                    client_id=cid,
                    title=pl.title,
                    description=pl.description,
                    category_id=pl.categoryId,
                    position=idx,
                    tracks_json=serialized_tracks,
                    metadata_json={},
                    is_shared=False,
                    share_token=None,
                    shared_at=None,
                    created_at=now,
                    updated_at=now,
                )
                db.add(row)
            else:
                # Preserve server-authoritative sharing state during library sync
                row.title = pl.title
                row.description = pl.description
                row.category_id = pl.categoryId
                row.position = idx
                row.tracks_json = serialized_tracks
                row.updated_at = now
            saved_rows.append(row)

        for cid, stale_row in existing_by_client.items():
            if cid not in incoming_client_ids:
                db.delete(stale_row)

        db.commit()
        for r in saved_rows:
            db.refresh(r)

        return PlaylistLibraryResponse(
            schemaVersion=1,
            updatedAt=_utc_iso(now),
            categories=payload.categories,
            playlists=[_row_to_playlist_item(r) for r in saved_rows],
            preferences=payload.preferences,
        )
    except SQLAlchemyError as exc:
        db.rollback()
        _handle_storage_unavailable(exc)
        raise  # pragma: no cover


@router.post("", response_model=PlaylistItemSchema, status_code=status.HTTP_201_CREATED)
def create_playlist(
    payload: PlaylistCreateRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    try:
        now = datetime.now(UTC)
        client_id = (payload.id or str(uuid.uuid4())).strip()
        existing = (
            db.query(UserPlaylist)
            .filter(
                UserPlaylist.user_id == current_user.id,
                UserPlaylist.record_type == PLAYLIST_RECORD_TYPE,
                UserPlaylist.client_id == client_id,
            )
            .first()
        )
        if existing is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="A playlist with this identifier already exists for your account.",
            )
        max_pos = (
            db.query(UserPlaylist)
            .filter(UserPlaylist.user_id == current_user.id, UserPlaylist.record_type == PLAYLIST_RECORD_TYPE)
            .count()
        )
        row = UserPlaylist(
            id=str(uuid.uuid4()),
            user_id=current_user.id,
            record_type=PLAYLIST_RECORD_TYPE,
            client_id=client_id,
            title=payload.title,
            description=payload.description,
            category_id=payload.categoryId,
            position=max_pos,
            tracks_json=[t.model_dump() for t in payload.tracks],
            metadata_json={},
            is_shared=False,
            share_token=None,
            shared_at=None,
            created_at=now,
            updated_at=now,
        )
        db.add(row)
        db.commit()
        db.refresh(row)
        return _row_to_playlist_item(row)
    except SQLAlchemyError as exc:
        db.rollback()
        _handle_storage_unavailable(exc)
        raise  # pragma: no cover


# Dedicated unauthenticated read-only endpoint registered BEFORE /{playlist_id}
@router.get("/shared/{share_token}", response_model=PublicSharedPlaylistResponse)
def get_public_shared_playlist(
    share_token: str,
    db: Session = Depends(get_db),
):
    if not SHARE_TOKEN_RE.match(share_token or ""):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Shared playlist not found or sharing has been disabled.",
        )

    try:
        row = (
            db.query(UserPlaylist)
            .filter(
                UserPlaylist.record_type == PLAYLIST_RECORD_TYPE,
                UserPlaylist.is_shared.is_(True),
                UserPlaylist.share_token == share_token,
            )
            .first()
        )
        if row is None or not row.share_token or not hmac.compare_digest(row.share_token, share_token):
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Shared playlist not found or sharing has been disabled.",
            )
        category_name = _resolve_category_name(db, row.user_id, row.category_id)
    except HTTPException:
        raise
    except SQLAlchemyError as exc:
        _handle_storage_unavailable(exc)
        raise  # pragma: no cover

    public_tracks: list[PublicSharedTrackSchema] = []
    for idx, raw_track in enumerate(row.tracks_json or [], start=1):
        if not isinstance(raw_track, dict):
            continue
        source_type = raw_track.get("sourceType")
        if source_type not in ("youtube", "project_audio"):
            continue

        raw_loop = raw_track.get("loop") if isinstance(raw_track.get("loop"), dict) else {}
        loop = TrackLoopMarkersSchema(
            aSec=raw_loop.get("aSec"),
            bSec=raw_loop.get("bSec"),
        )
        is_youtube = source_type == "youtube"
        yt_id = raw_track.get("youtubeVideoId") if is_youtube else None
        yt_url = raw_track.get("youtubeUrl") if is_youtube else None

        # Never leak user_id, email, projectId, mediaAssetId, or private media URLs
        public_tracks.append(
            PublicSharedTrackSchema(
                position=idx,
                title=str(raw_track.get("title") or "Untitled Track"),
                artist=str(raw_track.get("artist") or ""),
                sourceType=source_type,
                thumbnailUrl=raw_track.get("thumbnailUrl") if is_youtube else None,
                practiceNotes=str(raw_track.get("practiceNotes") or ""),
                loop=loop,
                youtubeVideoId=yt_id,
                youtubeUrl=yt_url,
                playablePublicly=bool(is_youtube and yt_id),
                unavailableReason=(
                    None
                    if is_youtube
                    else "Private ScribaSheet project audio files are kept private and are not exposed on public links."
                ),
            )
        )

    return PublicSharedPlaylistResponse(
        title=row.title,
        description=row.description or "",
        categoryName=category_name,
        sharedAt=_utc_iso(row.shared_at) if row.shared_at else None,
        updatedAt=_utc_iso(row.updated_at),
        tracks=public_tracks,
    )


@router.get("/{playlist_id}", response_model=PlaylistItemSchema)
def get_playlist(
    playlist_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    try:
        row = _find_playlist_row(db, playlist_id, current_user.id)
        return _row_to_playlist_item(row)
    except SQLAlchemyError as exc:
        _handle_storage_unavailable(exc)
        raise  # pragma: no cover


@router.patch("/{playlist_id}", response_model=PlaylistItemSchema)
def update_playlist(
    playlist_id: str,
    payload: PlaylistUpdateRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    try:
        row = _find_playlist_row(db, playlist_id, current_user.id)
        if payload.title is not None:
            row.title = payload.title
        if payload.description is not None:
            row.description = payload.description
        if payload.categoryId is not None:
            row.category_id = payload.categoryId
        if payload.position is not None:
            row.position = payload.position
        if payload.tracks is not None:
            row.tracks_json = [t.model_dump() for t in payload.tracks]
        row.updated_at = datetime.now(UTC)
        db.commit()
        db.refresh(row)
        return _row_to_playlist_item(row)
    except SQLAlchemyError as exc:
        db.rollback()
        _handle_storage_unavailable(exc)
        raise  # pragma: no cover


@router.delete("/{playlist_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_playlist(
    playlist_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    try:
        row = _find_playlist_row(db, playlist_id, current_user.id)
        db.delete(row)
        db.commit()
        return None
    except SQLAlchemyError as exc:
        db.rollback()
        _handle_storage_unavailable(exc)
        raise  # pragma: no cover


@router.post("/{playlist_id}/share", response_model=PlaylistShareStatusResponse)
def enable_playlist_share(
    playlist_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    try:
        row = _find_playlist_row(db, playlist_id, current_user.id)
        now = datetime.now(UTC)
        if not row.share_token:
            row.share_token = _generate_share_token()
        row.is_shared = True
        row.shared_at = now
        row.updated_at = now
        db.commit()
        db.refresh(row)
        return _row_to_share_status(row)
    except SQLAlchemyError as exc:
        db.rollback()
        _handle_storage_unavailable(exc)
        raise  # pragma: no cover


@router.post("/{playlist_id}/share/regenerate", response_model=PlaylistShareStatusResponse)
def regenerate_playlist_share(
    playlist_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    try:
        row = _find_playlist_row(db, playlist_id, current_user.id)
        now = datetime.now(UTC)
        row.share_token = _generate_share_token()
        row.is_shared = True
        row.shared_at = now
        row.updated_at = now
        db.commit()
        db.refresh(row)
        return _row_to_share_status(row)
    except SQLAlchemyError as exc:
        db.rollback()
        _handle_storage_unavailable(exc)
        raise  # pragma: no cover


@router.delete("/{playlist_id}/share", response_model=PlaylistShareStatusResponse)
def disable_playlist_share(
    playlist_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    try:
        row = _find_playlist_row(db, playlist_id, current_user.id)
        now = datetime.now(UTC)
        row.is_shared = False
        row.share_token = None
        row.shared_at = None
        row.updated_at = now
        db.commit()
        db.refresh(row)
        return _row_to_share_status(row)
    except SQLAlchemyError as exc:
        db.rollback()
        _handle_storage_unavailable(exc)
        raise  # pragma: no cover
