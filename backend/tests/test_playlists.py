from unittest.mock import patch


def _register_and_headers(client, email: str, name: str = "Listener"):
    res = client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": "StrongPassword123!", "display_name": name},
    )
    assert res.status_code == 201, res.text
    return {"Authorization": f"Bearer {res.json()['access_token']}"}, res.json()["user"]


def test_playlists_require_authentication(client):
    assert client.get("/api/v1/playlists").status_code == 401
    assert client.put("/api/v1/playlists/sync", json={"playlists": []}).status_code == 401
    assert client.post("/api/v1/playlists", json={"title": "Test"}).status_code == 401


def test_playlists_crud_sync_and_ownership_isolation(client):
    headers_a, _ = _register_and_headers(client, "playlist_alice@example.com", "Alice")
    headers_b, _ = _register_and_headers(client, "playlist_bob@example.com", "Bob")

    # Sync library for Alice
    sync_payload = {
        "schemaVersion": 1,
        "categories": [
            {"id": "cat-classical-violin", "name": "Classical Violin", "isDefault": True},
            {"id": "cat-custom-baroque", "name": "Baroque Urtext", "isDefault": False},
        ],
        "playlists": [
            {
                "id": "pl-alice-1",
                "title": "Mendelssohn Violin Concerto",
                "categoryId": "cat-classical-violin",
                "createdAt": "2026-11-28T10:00:00Z",
                "updatedAt": "2026-11-28T10:00:00Z",
                "tracks": [
                    {
                        "id": "trk-yt-1",
                        "sourceType": "youtube",
                        "title": "Mendelssohn Violin Concerto 1st Mvt",
                        "artist": "Soloist Example",
                        "categoryId": "cat-classical-violin",
                        "thumbnailUrl": "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
                        "practiceNotes": "Watch shift to 3rd position at 1:42",
                        "loop": {"aSec": 102.0, "bSec": 118.5},
                        "youtubeVideoId": "dQw4w9WgXcQ",
                        "youtubeUrl": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
                        "addedAt": "2026-11-28T10:00:00Z",
                        "updatedAt": "2026-11-28T10:00:00Z",
                    }
                ],
            }
        ],
        "preferences": {
            "shuffle": True,
            "autoAdvance": True,
            "playbackRate": 0.85,
            "miniPlayerEnabled": True,
        },
    }
    sync_res = client.put("/api/v1/playlists/sync", headers=headers_a, json=sync_payload)
    assert sync_res.status_code == 200, sync_res.text
    synced = sync_res.json()
    assert len(synced["playlists"]) == 1
    assert synced["playlists"][0]["tracks"][0]["loop"] == {"aSec": 102.0, "bSec": 118.5}
    assert synced["preferences"]["playbackRate"] == 0.85
    alice_server_id = synced["playlists"][0]["serverId"]
    assert alice_server_id

    # Alice reads back her library
    get_a = client.get("/api/v1/playlists", headers=headers_a)
    assert get_a.status_code == 200
    assert len(get_a.json()["playlists"]) == 1

    # Bob's GET does NOT expose Alice's playlists
    get_b = client.get("/api/v1/playlists", headers=headers_b)
    assert get_b.status_code == 200
    assert get_b.json()["playlists"] == []

    # Bob is forbidden (403) from reading, updating, or deleting Alice's playlist by serverId
    assert client.get(f"/api/v1/playlists/{alice_server_id}", headers=headers_b).status_code == 403
    assert (
        client.patch(
            f"/api/v1/playlists/{alice_server_id}",
            headers=headers_b,
            json={"title": "Hijacked"},
        ).status_code
        == 403
    )
    assert client.delete(f"/api/v1/playlists/{alice_server_id}", headers=headers_b).status_code == 403

    # Alice updates and creates single playlist
    patch_a = client.patch(
        f"/api/v1/playlists/{alice_server_id}",
        headers=headers_a,
        json={"title": "Mendelssohn Op. 64"},
    )
    assert patch_a.status_code == 200
    assert patch_a.json()["title"] == "Mendelssohn Op. 64"

    # Bob can use the same client-side ID without colliding with Alice
    create_b = client.post(
        "/api/v1/playlists",
        headers=headers_b,
        json={"id": "pl-alice-1", "title": "Bob Choir", "categoryId": "cat-choral-satb", "tracks": []},
    )
    assert create_b.status_code == 201
    bob_server_id = create_b.json()["serverId"]
    assert bob_server_id != alice_server_id

    assert client.delete(f"/api/v1/playlists/{alice_server_id}", headers=headers_a).status_code == 204
    assert client.get(f"/api/v1/playlists/{alice_server_id}", headers=headers_a).status_code == 404


def test_playlists_validation_rejects_invalid_payloads(client):
    headers, _ = _register_and_headers(client, "playlist_val@example.com", "Validator")

    # Invalid 11-char YouTube ID
    bad_yt = {
        "title": "Bad YT",
        "tracks": [
            {
                "id": "t1",
                "sourceType": "youtube",
                "title": "Bad ID",
                "youtubeVideoId": "short",
                "addedAt": "2026-11-28T10:00:00Z",
                "updatedAt": "2026-11-28T10:00:00Z",
            }
        ],
    }
    assert client.post("/api/v1/playlists", headers=headers, json=bad_yt).status_code == 422

    # Invalid A-B loop range (B <= A)
    bad_loop = {
        "title": "Bad Loop",
        "tracks": [
            {
                "id": "t2",
                "sourceType": "project_audio",
                "title": "Loop Err",
                "projectId": "proj-1",
                "loop": {"aSec": 30.0, "bSec": 10.0},
                "addedAt": "2026-11-28T10:00:00Z",
                "updatedAt": "2026-11-28T10:00:00Z",
            }
        ],
    }
    assert client.post("/api/v1/playlists", headers=headers, json=bad_loop).status_code == 422

    # Forbidden data: thumbnail URI (no embedded binaries)
    bad_thumb = {
        "title": "Binary Thumb",
        "tracks": [
            {
                "id": "t3",
                "sourceType": "youtube",
                "title": "Data URI",
                "youtubeVideoId": "dQw4w9WgXcQ",
                "thumbnailUrl": "data:image/png;base64,AAAA",
                "addedAt": "2026-11-28T10:00:00Z",
                "updatedAt": "2026-11-28T10:00:00Z",
            }
        ],
    }
    assert client.post("/api/v1/playlists", headers=headers, json=bad_thumb).status_code == 422


def test_url_check_extracts_strict_youtube_ids_and_strips_radio_params(client):
    headers, _ = _register_and_headers(client, "ytcheck@example.com", "YT Check")

    class FakeResp:
        status_code = 200

        def json(self):
            return {
                "title": "Bach Violin Partita No. 2",
                "author_name": "Hilary Hahn",
                "thumbnail_url": "https://i.ytimg.com/vi/6KaYzg0ebfE/hqdefault.jpg",
            }

    with patch("httpx.get", return_value=FakeResp()):
        res1 = client.post(
            "/api/v1/uploads/url-check",
            headers=headers,
            json={"url": "https://www.youtube.com/watch?v=6KaYzg0ebfE&list=RD6KaYzg0ebfE&start_radio=1"},
        )
        assert res1.status_code == 200
        d1 = res1.json()
        assert d1["supported"] is False
        assert d1["is_youtube"] is True
        assert d1["video_id"] == "6KaYzg0ebfE"
        assert d1["title"] == "Bach Violin Partita No. 2"
        assert d1["thumbnail_url"] == "https://i.ytimg.com/vi/6KaYzg0ebfE/hqdefault.jpg"

        res2 = client.post(
            "/api/v1/uploads/url-check",
            headers=headers,
            json={"url": "https://youtu.be/6KaYzg0ebfE?si=abc123&list=RDxyz"},
        )
        assert res2.status_code == 200
        assert res2.json()["video_id"] == "6KaYzg0ebfE"

    bad = client.post(
        "/api/v1/uploads/url-check",
        headers=headers,
        json={"url": "https://www.youtube.com/watch?v=invalid"},
    )
    assert bad.status_code == 400


def test_public_playlist_sharing_security_lifecycle_and_isolation(client):
    headers_a, user_a = _register_and_headers(client, "teacher_owner@example.com", "Prof. Clara")
    headers_b, _ = _register_and_headers(client, "other_user@example.com", "Intruder")

    # 1. Create playlist containing 1 YouTube track (with practice notes + A-B loop) & 1 private Project Audio track
    create_res = client.post(
        "/api/v1/playlists",
        headers=headers_a,
        json={
            "id": "pl-lesson-share",
            "title": "Lesson 4: Partita & Scales",
            "description": "Practice slow bowings first before tempo.",
            "categoryId": "cat-classical-violin",
            "tracks": [
                {
                    "id": "tr-pub-yt",
                    "sourceType": "youtube",
                    "title": "Bach Partita No. 2 Chaconne",
                    "artist": "J.S. Bach",
                    "categoryId": "cat-classical-violin",
                    "thumbnailUrl": "https://i.ytimg.com/vi/6KaYzg0ebfE/hqdefault.jpg",
                    "practiceNotes": "Watch shift to 3rd position at 1:42",
                    "loop": {"aSec": 102.0, "bSec": 118.0},
                    "youtubeVideoId": "6KaYzg0ebfE",
                    "youtubeUrl": "https://www.youtube.com/watch?v=6KaYzg0ebfE",
                    "addedAt": "2026-11-28T10:00:00Z",
                    "updatedAt": "2026-11-28T10:00:00Z",
                },
                {
                    "id": "tr-priv-audio",
                    "sourceType": "project_audio",
                    "title": "Student Private Take",
                    "artist": "Clara",
                    "categoryId": "cat-practice-reference",
                    "practiceNotes": "Private lesson recording",
                    "projectId": "secret-project-999",
                    "mediaAssetId": "secret-asset-888",
                    "projectTitle": "Confidential Audition",
                    "mediaFilename": "secret.mp3",
                    "addedAt": "2026-11-28T10:00:00Z",
                    "updatedAt": "2026-11-28T10:00:00Z",
                },
            ],
        },
    )
    assert create_res.status_code == 201, create_res.text
    created = create_res.json()
    assert created["isShared"] is False
    assert created["shareToken"] is None
    server_id = created["serverId"]

    # Non-owner cannot enable, regenerate, or disable sharing
    assert client.post(f"/api/v1/playlists/{server_id}/share", headers=headers_b).status_code == 403
    assert client.post(f"/api/v1/playlists/{server_id}/share/regenerate", headers=headers_b).status_code == 403
    assert client.delete(f"/api/v1/playlists/{server_id}/share", headers=headers_b).status_code == 403

    # Owner enables sharing -> generates cryptographically strong token
    share_res = client.post(f"/api/v1/playlists/{server_id}/share", headers=headers_a)
    assert share_res.status_code == 200, share_res.text
    token1 = share_res.json()["shareToken"]
    assert token1 and len(token1) >= 32
    assert share_res.json()["isShared"] is True

    # Unauthenticated visitor can read ONLY sanitized public data
    pub_res = client.get(f"/api/v1/playlists/shared/{token1}")
    assert pub_res.status_code == 200, pub_res.text
    raw_text = pub_res.text
    assert user_a["id"] not in raw_text
    assert "teacher_owner@example.com" not in raw_text
    assert "secret-project-999" not in raw_text
    assert "secret-asset-888" not in raw_text
    assert "Confidential Audition" not in raw_text
    assert "secret.mp3" not in raw_text

    pub_data = pub_res.json()
    assert pub_data["title"] == "Lesson 4: Partita & Scales"
    assert pub_data["description"] == "Practice slow bowings first before tempo."
    assert pub_data["categoryName"] == "Classical Violin"
    assert len(pub_data["tracks"]) == 2
    assert pub_data["tracks"][0]["playablePublicly"] is True
    assert pub_data["tracks"][0]["youtubeVideoId"] == "6KaYzg0ebfE"
    assert pub_data["tracks"][0]["practiceNotes"] == "Watch shift to 3rd position at 1:42"
    assert pub_data["tracks"][0]["loop"] == {"aSec": 102.0, "bSec": 118.0}
    assert pub_data["tracks"][1]["playablePublicly"] is False
    assert "private" in pub_data["tracks"][1]["unavailableReason"].lower()

    # Sync does not erase server sharing state or allow spoofing tokens
    client.put(
        "/api/v1/playlists/sync",
        headers=headers_a,
        json={
            "schemaVersion": 1,
            "categories": [],
            "playlists": [
                {
                    **created,
                    "description": "Updated description",
                    "isShared": False,
                    "shareToken": "spoofed-token-12345678901234567890",
                }
            ],
            "preferences": {"shuffle": False, "autoAdvance": True, "playbackRate": 1.0, "miniPlayerEnabled": False},
        },
    )
    assert client.get(f"/api/v1/playlists/shared/{token1}").status_code == 200
    assert client.get("/api/v1/playlists/shared/spoofed-token-12345678901234567890").status_code == 404

    # Public endpoint is strictly read-only
    assert client.patch(f"/api/v1/playlists/shared/{token1}", json={"title": "Hacked"}).status_code == 405
    assert client.delete(f"/api/v1/playlists/shared/{token1}").status_code == 405

    # Invalid / short / unknown tokens return 404
    assert client.get("/api/v1/playlists/shared/too-short").status_code == 404
    assert client.get("/api/v1/playlists/shared/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa").status_code == 404

    # Regenerate token immediately invalidates previous link and activates new link
    regen_res = client.post(f"/api/v1/playlists/{server_id}/share/regenerate", headers=headers_a)
    assert regen_res.status_code == 200
    token2 = regen_res.json()["shareToken"]
    assert token2 and token2 != token1
    assert client.get(f"/api/v1/playlists/shared/{token1}").status_code == 404
    assert client.get(f"/api/v1/playlists/shared/{token2}").status_code == 200

    # Disable sharing immediately revokes access
    del_res = client.delete(f"/api/v1/playlists/{server_id}/share", headers=headers_a)
    assert del_res.status_code == 200
    assert del_res.json()["isShared"] is False
    assert del_res.json()["shareToken"] is None
    assert client.get(f"/api/v1/playlists/shared/{token2}").status_code == 404

