def _register_and_headers(client, email: str, password: str = "StrongPass123!", name: str = "Musician"):
    res = client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": password, "display_name": name},
    )
    assert res.status_code == 201, res.text
    token = res.json()["access_token"]
    return {"Authorization": f"Bearer {token}"}, res.json()["user"]


def test_health_and_readiness(client):
    root = client.get("/")
    assert root.status_code == 200
    root_data = root.json()
    assert root_data["name"] == "ScribaSheet API"
    assert root_data["status"] == "running"
    assert root_data["docs"] == "/docs"
    assert root_data["health"] == "/health"

    h = client.get("/health")
    assert h.status_code == 200
    assert h.json()["status"] == "ok"

    r = client.get("/ready")
    assert r.status_code == 200
    assert r.json()["checks"]["basic_pitch_onnx"] == "ok"


def test_auth_lifecycle_and_ownership(client):
    headers_a, user_a = _register_and_headers(client, "alice@example.com", name="Alice")
    headers_b, _ = _register_and_headers(client, "bob@example.com", name="Bob")

    # Profile fetch & update
    me = client.get("/api/v1/users/me", headers=headers_a)
    assert me.status_code == 200
    assert me.json()["email"] == "alice@example.com"

    upd = client.patch("/api/v1/users/me", headers=headers_a, json={"display_name": "Alice Keys"})
    assert upd.status_code == 200
    assert upd.json()["display_name"] == "Alice Keys"

    # Alice creates project
    p_res = client.post(
        "/api/v1/projects",
        headers=headers_a,
        json={"title": "Nocturne Sketch", "instrument": "piano", "transcription_mode": "piano"},
    )
    assert p_res.status_code == 201
    project_id = p_res.json()["id"]

    # Bob cannot read, update, duplicate, or delete Alice's project
    assert client.get(f"/api/v1/projects/{project_id}", headers=headers_b).status_code == 403
    assert client.patch(f"/api/v1/projects/{project_id}", headers=headers_b, json={"title": "Stolen"}).status_code == 403
    assert client.delete(f"/api/v1/projects/{project_id}", headers=headers_b).status_code == 403

    # Alice can duplicate & list with search
    dup = client.post(f"/api/v1/projects/{project_id}/duplicate", headers=headers_a)
    assert dup.status_code == 201
    assert "Copy" in dup.json()["title"]

    lst = client.get("/api/v1/projects?search=Nocturne", headers=headers_a)
    assert lst.status_code == 200
    assert lst.json()["total"] == 2

    # Delete copy
    assert client.delete(f"/api/v1/projects/{dup.json()['id']}", headers=headers_a).status_code == 204


def test_delete_account_authorization_ownership_and_cleanup(client):
    # Unauthenticated and invalid-token requests must be rejected
    assert client.delete("/api/v1/users/me").status_code == 401
    assert (
        client.delete("/api/v1/users/me", headers={"Authorization": "Bearer invalid.jwt.token"}).status_code == 401
    )

    reg_a = client.post(
        "/api/v1/auth/register",
        json={"email": "delete_owner_a@example.com", "password": "StrongPass123!", "display_name": "Owner A"},
    )
    assert reg_a.status_code == 201
    tokens_a = reg_a.json()
    headers_a = {"Authorization": f"Bearer {tokens_a['access_token']}"}
    headers_refresh_a = {"Authorization": f"Bearer {tokens_a['refresh_token']}"}

    # Refresh token cannot be used as access token to delete account
    assert client.delete("/api/v1/users/me", headers=headers_refresh_a).status_code == 401

    headers_b, _ = _register_and_headers(client, "delete_owner_b@example.com", name="Owner B")

    proj_a = client.post(
        "/api/v1/projects",
        headers=headers_a,
        json={"title": "Owner A Private Piece", "instrument": "piano", "transcription_mode": "piano"},
    )
    proj_b = client.post(
        "/api/v1/projects",
        headers=headers_b,
        json={"title": "Owner B Intact Piece", "instrument": "piano", "transcription_mode": "piano"},
    )
    assert proj_a.status_code == 201 and proj_b.status_code == 201

    # Owner A deletes their own account -> 204, tokens become invalid, User B unaffected
    del_res = client.delete("/api/v1/users/me", headers=headers_a)
    assert del_res.status_code == 204
    assert client.get("/api/v1/users/me", headers=headers_a).status_code == 401
    assert client.delete("/api/v1/users/me", headers=headers_a).status_code == 401

    # Owner B account and project remain completely untouched
    b_proj_check = client.get(f"/api/v1/projects/{proj_b.json()['id']}", headers=headers_b)
    assert b_proj_check.status_code == 200
    assert b_proj_check.json()["title"] == "Owner B Intact Piece"
