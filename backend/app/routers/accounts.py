"""Sign-up (18+ only), sign-in, sign-out, "my data" and "delete my data" (plan 2.1, 2.2, 2.5, 2.7)."""

import time
from collections import defaultdict, deque
from datetime import date, datetime, timezone
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app import google
from app.auth import SESSION_LIFETIME, current_session, current_user
from app.config import get_settings
from app.db import get_db
from app.filters import CATEGORY_GROUPS, DEFAULT_HIDDEN_GROUPS
from app.models import AuthSession, Consent, Feedback, User, UserSettings
from app.security import hash_password, hash_token, new_token, pseudonym, verify_password

router = APIRouter(prefix="/api", tags=["accounts"])

NOTICE_VERSION = "v2"  # v2 (2026-10-05): notes, groups, feedback, AI notes, Google sign-in
INDIA = ZoneInfo("Asia/Kolkata")


class SignupIn(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=200)
    date_of_birth: date  # used once for the 18+ check, never stored
    accepted_notice: bool  # the first-run notice (plan 2.7)


class LoginIn(BaseModel):
    email: EmailStr
    password: str = Field(max_length=200)


class SettingsOut(BaseModel):
    shorts_enabled: bool
    shorts_daily_limit_min: int | None
    search_language: str
    hidden_groups: list[str]


class MeOut(BaseModel):
    email: str
    created_at: datetime
    settings: SettingsOut


class TokenOut(BaseModel):
    token: str
    me: MeOut


def age_on(dob: date, today: date) -> int:
    return today.year - dob.year - ((today.month, today.day) < (dob.month, dob.day))


def today_in_india() -> date:
    return datetime.now(INDIA).date()


# Small in-memory limits, enough for one instance. Keyed on the email, not the IP: X-Forwarded-For can be
# forged by anyone calling the backend directly, so an IP key would let a guesser rotate past the limit.
# ponytail: in-memory per process; move to the database if the app runs on several instances.
_attempts: dict[str, deque[float]] = defaultdict(deque)
MAX_ATTEMPTS, WINDOW_S = 5, 60
NEW_ACCOUNTS_PER_MINUTE = 20  # whole app: sign-up runs argon2, so a flood would eat the free server


def _too_many(key: str, limit: int = MAX_ATTEMPTS) -> bool:
    now = time.monotonic()
    for k in [k for k, old in _attempts.items() if not old or now - old[-1] > WINDOW_S]:
        del _attempts[k]  # forget quiet keys, so the dict can't grow without end
    q = _attempts[key]
    while q and now - q[0] > WINDOW_S:
        q.popleft()
    if len(q) >= limit:
        return True
    q.append(now)
    return False


def _me(user: User) -> MeOut:
    s = user.settings or UserSettings(shorts_enabled=False, shorts_daily_limit_min=None, search_language="en")
    return MeOut(
        email=user.email,
        created_at=user.created_at,
        settings=SettingsOut(
            shorts_enabled=s.shorts_enabled,
            shorts_daily_limit_min=s.shorts_daily_limit_min,
            search_language=s.search_language,
            hidden_groups=sorted(DEFAULT_HIDDEN_GROUPS if s.hidden_groups is None else s.hidden_groups),
        ),
    )


def _start_session(db: Session, user: User) -> str:
    token = new_token()
    db.add(
        AuthSession(
            user_id=user.id,
            token_hash=hash_token(token),
            expires_at=datetime.now(timezone.utc) + SESSION_LIFETIME,
        )
    )
    return token


def _check_adult(date_of_birth: date, accepted_notice: bool, request: Request) -> None:
    today = today_in_india()
    if date_of_birth > today or date_of_birth.year < 1900:
        raise HTTPException(status_code=422, detail="invalid_date_of_birth")
    if age_on(date_of_birth, today) < 18:
        # R10: refuse, and store nothing about this person (no row, no email in the log).
        request.state.action = "signup_refused_under_18"
        raise HTTPException(status_code=403, detail="under_18")
    if not accepted_notice:
        raise HTTPException(status_code=422, detail="notice_not_accepted")


def _create_user(db: Session, email: str, password_hash: str) -> User:
    now = datetime.now(timezone.utc)
    user = User(email=email, password_hash=password_hash, adult_confirmed_at=now)
    user.settings = UserSettings(shorts_enabled=False, shorts_daily_limit_min=None, search_language="en")
    user.consents.append(Consent(kind="notice", version=NOTICE_VERSION, granted_at=now))
    db.add(user)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="email_taken") from None
    return user


@router.post("/auth/signup", response_model=TokenOut, status_code=201)
def signup(body: SignupIn, request: Request, db: Session = Depends(get_db)) -> TokenOut:
    request.state.action = "signup"
    if _too_many("new-account", NEW_ACCOUNTS_PER_MINUTE):
        raise HTTPException(status_code=429, detail="too_many_attempts")
    _check_adult(body.date_of_birth, body.accepted_notice, request)
    user = _create_user(db, body.email.lower(), hash_password(body.password))
    token = _start_session(db, user)
    db.commit()
    request.state.actor = pseudonym(user.id)
    return TokenOut(token=token, me=_me(user))


# Google accounts have no password: this is not a valid hash, so password sign-in always fails for them.
NO_PASSWORD = "!google"


class GoogleIn(BaseModel):
    credential: str = Field(min_length=20, max_length=4096)
    # Only for a new account: Google doesn't tell us their age, so the user confirms 18+ here (R10).
    date_of_birth: date | None = None
    accepted_notice: bool = False


@router.get("/config")
def public_config() -> dict:
    return {"google_client_id": get_settings().google_client_id or None}


@router.post("/auth/google", response_model=TokenOut)
def google_auth(body: GoogleIn, request: Request, db: Session = Depends(get_db)) -> TokenOut:
    """Continue with Google: signs in an existing account, or creates one when 18+ and the notice are confirmed."""
    request.state.action = "google_auth"
    try:
        info = google.verify_id_token(body.credential)
    except google.GoogleError as e:
        code = str(e)
        raise HTTPException(status_code=503 if code == "google_not_configured" else 401, detail=code) from None
    user = db.scalar(select(User).where(User.email == info["email"]))
    if user is None:
        if body.date_of_birth is None:
            raise HTTPException(status_code=404, detail="no_account")
        if _too_many("new-account", NEW_ACCOUNTS_PER_MINUTE):
            raise HTTPException(status_code=429, detail="too_many_attempts")
        _check_adult(body.date_of_birth, body.accepted_notice, request)
        user = _create_user(db, info["email"], NO_PASSWORD)
    elif user.password_hash != NO_PASSWORD:
        # Email sign-up never proves the address, Google does. Someone could have signed up with this email and a
        # password before its real owner arrived: drop that password and every old session, so only Google opens it.
        user.password_hash = NO_PASSWORD
        db.execute(delete(AuthSession).where(AuthSession.user_id == user.id))
    token = _start_session(db, user)
    db.commit()
    request.state.actor = pseudonym(user.id)
    return TokenOut(token=token, me=_me(user))


@router.post("/auth/login", response_model=TokenOut)
def login(body: LoginIn, request: Request, db: Session = Depends(get_db)) -> TokenOut:
    request.state.action = "login"
    if _too_many(body.email.lower()):
        raise HTTPException(status_code=429, detail="too_many_attempts")
    user = db.scalar(select(User).where(User.email == body.email.lower()))
    if user is not None and user.password_hash == NO_PASSWORD:
        # A Google account has no password: say so, or the person keeps retyping a password that can't work.
        raise HTTPException(status_code=401, detail="use_google")
    if user is None or not verify_password(user.password_hash, body.password):
        raise HTTPException(status_code=401, detail="wrong_email_or_password")
    token = _start_session(db, user)
    db.commit()
    request.state.actor = pseudonym(user.id)
    return TokenOut(token=token, me=_me(user))


@router.post("/auth/logout", status_code=204)
def logout(request: Request, session: AuthSession = Depends(current_session), db: Session = Depends(get_db)) -> None:
    request.state.action = "logout"
    db.execute(delete(AuthSession).where(AuthSession.id == session.id))
    db.commit()


class SettingsIn(BaseModel):
    shorts_enabled: bool | None = None
    hidden_groups: list[str] | None = Field(default=None, max_length=len(CATEGORY_GROUPS))


@router.post("/me/settings", response_model=MeOut)
def update_settings(body: SettingsIn, user: User = Depends(current_user), db: Session = Depends(get_db)) -> MeOut:
    if user.settings is None:
        user.settings = UserSettings(shorts_enabled=False, shorts_daily_limit_min=None, search_language="en")
    if body.shorts_enabled is not None:
        user.settings.shorts_enabled = body.shorts_enabled
    if body.hidden_groups is not None:
        if not set(body.hidden_groups) <= CATEGORY_GROUPS.keys():
            raise HTTPException(status_code=422, detail="unknown_group")
        user.settings.hidden_groups = sorted(set(body.hidden_groups))
    db.commit()
    return _me(user)


FEEDBACK_PAGES = r"^(|/|/search|/shorts|/library|/personal|/settings|/watch/:id|/groups|/groups/:id)$"


class FeedbackIn(BaseModel):
    text: str = Field(min_length=3, max_length=2000)
    page: str = Field(default="", pattern=FEEDBACK_PAGES)  # a known route template only, never an ID (R11)


@router.post("/feedback", status_code=201)
def feedback(body: FeedbackIn, request: Request, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    request.state.action = "feedback"
    db.add(Feedback(user_id=user.id, text=body.text.strip(), page=body.page))
    db.commit()
    return {"ok": True}


@router.get("/me", response_model=MeOut)
def me(user: User = Depends(current_user)) -> MeOut:
    return _me(user)


@router.delete("/me")
def delete_me(request: Request, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    """Deletes the account and all its data at once (R2 allows up to 7 days; we don't wait)."""
    request.state.action = "account_deleted"
    db.delete(user)
    db.commit()
    return {
        "deleted": True,
        "note": "Your account and everything we stored for it are deleted. This doesn't delete anything on YouTube.",
    }
