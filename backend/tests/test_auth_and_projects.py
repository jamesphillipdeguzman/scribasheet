def _register_and_headers(client, email: str, password: str = "StrongPass123!", name: str = "Musician"):
    res = client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": password, "display_name": name},
    )
    assert res.status_code == 201, res.text
    token = res.json()["access_token"]
    return {"Authorization": f"Bearer {token}"}, res.json()["user"]


def test_health_and_readiness(client):
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
