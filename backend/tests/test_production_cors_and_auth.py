import uuid

from sqlalchemy import create_engine, inspect, text

from app.core.security import decode_token
from app.db.migrate import run_startup_migrations
from app.db.session import Base


def test_cors_preflight_login_and_error_headers(client):
    prod_origin = "https://scribasheet.vercel.app"

    # 1. OPTIONS /api/v1/auth/login without JWT
    opt = client.options(
        "/api/v1/auth/login",
        headers={
            "Origin": prod_origin,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type,authorization",
        },
    )
    assert opt.status_code == 200
    assert opt.headers.get("access-control-allow-origin") == prod_origin
    assert "POST" in (opt.headers.get("access-control-allow-methods") or "")
    allow_headers = (opt.headers.get("access-control-allow-headers") or "").lower()
    assert "content-type" in allow_headers
    assert "authorization" in allow_headers

    # 2. Unapproved origin is rejected / not granted CORS header
    bad_opt = client.options(
        "/api/v1/auth/login",
        headers={
            "Origin": "https://evil.example.com",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        },
    )
    assert bad_opt.status_code == 400
    assert bad_opt.headers.get("access-control-allow-origin") is None


def test_login_success_invalid_credentials_and_validation_preserve_cors(client):
    prod_origin = "https://scribasheet.vercel.app"
    email = f"login_prod_{uuid.uuid4().hex[:8]}@example.com"
    password = "StrongPassword123!"

    reg = client.post(
        "/api/v1/auth/register",
        headers={"Origin": prod_origin},
        json={"email": email, "password": password, "display_name": "Login Tester"},
    )
    assert reg.status_code == 201

    # Valid login
    ok_res = client.post(
        "/api/v1/auth/login",
        headers={"Origin": prod_origin},
        json={"email": email, "password": password},
    )
    assert ok_res.status_code == 200
    assert ok_res.headers.get("access-control-allow-origin") == prod_origin
    tokens = ok_res.json()
    claims = decode_token(tokens["access_token"])
    assert claims["email"] == email

    # Invalid credentials -> 401 with CORS header
    bad_pw = client.post(
        "/api/v1/auth/login",
        headers={"Origin": prod_origin},
        json={"email": email, "password": "WrongPassword!"},
    )
    assert bad_pw.status_code == 401
    assert bad_pw.headers.get("access-control-allow-origin") == prod_origin

    # Invalid payload -> 422 with CORS header
    bad_payload = client.post(
        "/api/v1/auth/login",
        headers={"Origin": prod_origin},
        json={"email": "not-an-email"},
    )
    assert bad_payload.status_code == 422
    assert bad_payload.headers.get("access-control-allow-origin") == prod_origin


def test_app_startup_health_and_idempotent_migrations(client, tmp_path):
    from app.main import app

    assert app is not None
    health = client.get("/health")
    assert health.status_code == 200
    assert health.json()["status"] == "ok"

    # 1. Clean empty SQLite DB migrates to head
    clean_db = tmp_path / "clean.db"
    clean_engine = create_engine(f"sqlite:///{clean_db}", future=True)
    run_startup_migrations(clean_engine)
    assert "worker_nodes" in set(inspect(clean_engine).get_table_names())
    with clean_engine.connect() as conn:
        ver = conn.execute(text("SELECT version_num FROM alembic_version")).scalar_one()
        assert ver == "e3a4c19f8b12"
    clean_engine.dispose()

    # 2. Pre-existing unstamped DB (without alembic_version and without worker_nodes) upgrades cleanly
    legacy_db = tmp_path / "legacy.db"
    legacy_engine = create_engine(f"sqlite:///{legacy_db}", future=True)
    Base.metadata.create_all(bind=legacy_engine)
    with legacy_engine.begin() as conn:
        conn.execute(text("DROP TABLE worker_nodes"))
    run_startup_migrations(legacy_engine)
    assert "worker_nodes" in set(inspect(legacy_engine).get_table_names())
    with legacy_engine.connect() as conn:
        ver = conn.execute(text("SELECT version_num FROM alembic_version")).scalar_one()
        assert ver == "e3a4c19f8b12"
    legacy_engine.dispose()
