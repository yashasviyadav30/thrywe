from datetime import date, datetime, timedelta, timezone

from sqlalchemy import func, select

from app.models import AppLog, AuthSession, Consent, Follow, Goal, Mute, User, UserSettings
from app.routers.accounts import age_on
from tests.conftest import ADULT


def count(db, model):
    return db.scalar(select(func.count()).select_from(model))


def test_age_calculation():
    assert age_on(date(2008, 9, 30), date(2026, 9, 29)) == 17  # birthday tomorrow
    assert age_on(date(2008, 9, 29), date(2026, 9, 29)) == 18  # birthday today
    assert age_on(date(2000, 1, 1), date(2026, 9, 29)) == 26


def test_adult_can_sign_up(client, db):
    r = client.post("/api/auth/signup", json=ADULT)
    assert r.status_code == 201
    body = r.json()
    assert body["token"]
    assert body["me"]["email"] == "asha@example.com"
    assert body["me"]["settings"]["shorts_enabled"] is False  # off by default for everyone
    assert count(db, Consent) == 1


def test_date_of_birth_is_not_stored(client, db):
    client.post("/api/auth/signup", json=ADULT)
    assert "date_of_birth" not in User.__table__.columns
    assert db.scalar(select(User)).adult_confirmed_at is not None


def test_under_18_is_refused_and_nothing_is_stored(client, db):
    kid = ADULT | {"email": "kid@example.com", "date_of_birth": f"{date.today().year - 16}-01-01"}
    r = client.post("/api/auth/signup", json=kid)
    assert r.status_code == 403
    assert r.json()["detail"] == "under_18"
    assert count(db, User) == 0
    log = db.scalar(select(AppLog))
    assert log.action == "signup_refused_under_18"
    assert log.actor is None and log.ip_prefix is None


def test_notice_must_be_accepted(client, db):
    r = client.post("/api/auth/signup", json=ADULT | {"accepted_notice": False})
    assert r.status_code == 422
    assert count(db, User) == 0


def test_duplicate_email(client):
    client.post("/api/auth/signup", json=ADULT)
    r = client.post("/api/auth/signup", json=ADULT | {"email": "ASHA@example.com"})
    assert r.status_code == 409


def test_future_date_of_birth_is_rejected(client):
    r = client.post("/api/auth/signup", json=ADULT | {"date_of_birth": "2999-01-01"})
    assert r.status_code == 422


def test_login_and_wrong_password(client):
    client.post("/api/auth/signup", json=ADULT)
    ok = client.post("/api/auth/login", json={"email": "Asha@Example.com", "password": ADULT["password"]})
    assert ok.status_code == 200 and ok.json()["token"]
    bad = client.post("/api/auth/login", json={"email": ADULT["email"], "password": "nope nope"})
    assert bad.status_code == 401


def test_login_is_rate_limited(client):
    client.post("/api/auth/signup", json=ADULT)
    codes = [client.post("/api/auth/login", json={"email": ADULT["email"], "password": "wrong"}).status_code for _ in range(6)]
    assert codes[:5] == [401] * 5 and codes[5] == 429


def test_me_needs_a_token(client):
    assert client.get("/api/me").status_code == 401


def test_me_and_logout(signed_in):
    assert signed_in.get("/api/me").json()["email"] == "asha@example.com"
    assert signed_in.post("/api/auth/logout").status_code == 204
    assert signed_in.get("/api/me").status_code == 401


def test_using_the_app_keeps_you_signed_in(signed_in, db):
    session = db.scalar(select(AuthSession))
    session.expires_at = datetime.now(timezone.utc) + timedelta(days=5)  # signed in 55 days ago
    db.commit()
    assert signed_in.get("/api/me").status_code == 200
    db.refresh(session)
    left = session.expires_at.replace(tzinfo=timezone.utc) - datetime.now(timezone.utc)
    assert left > timedelta(days=59)  # renewed, so a daily user never meets the sign-in page again


def test_delete_my_data_removes_everything(signed_in, db):
    user = db.scalar(select(User))
    db.add_all([
        Goal(user_id=user.id, raw_text="CMA Inter costing"),
        Mute(user_id=user.id, kind="channel", value="UCxxxxxxxxxxxxxxxxxxxxxx"),
        Follow(user_id=user.id, channel_id="UCyyyyyyyyyyyyyyyyyyyyyy"),
    ])
    db.commit()
    r = signed_in.delete("/api/me")
    assert r.status_code == 200
    assert "doesn't delete anything on YouTube" in r.json()["note"]
    db.expire_all()
    for model in (User, AuthSession, Consent, Goal, Mute, Follow, UserSettings):
        assert count(db, model) == 0, model.__name__
    assert signed_in.get("/api/me").status_code == 401


def test_feedback_is_saved_and_deleted_with_the_account(signed_in, db):
    from app.models import Feedback

    assert signed_in.post("/api/feedback", json={"text": "The mind map is great", "page": "/watch/:id"}).status_code == 201
    assert signed_in.post("/api/feedback", json={"text": "x", "page": ""}).status_code == 422
    assert signed_in.post("/api/feedback", json={"text": "no ids", "page": "/watch/abcdefghijk"}).status_code == 422
    assert [f.text for f in db.query(Feedback)] == ["The mind map is great"]
    signed_in.delete("/api/me")
    db.expire_all()
    assert db.query(Feedback).count() == 0


def test_login_limit_ignores_a_forged_forwarded_for(client):
    codes = [
        client.post(
            "/api/auth/login",
            json={"email": "nobody@example.com", "password": "wrong password"},
            headers={"X-Forwarded-For": f"10.0.0.{i}"},
        ).status_code
        for i in range(6)
    ]
    assert codes[5] == 429
