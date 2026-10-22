"""Who is calling: bearer token → user."""

from datetime import datetime, timedelta, timezone

from fastapi import Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.orm import Session, joinedload

from app.db import get_db
from app.models import AuthSession, User
from app.security import hash_token, pseudonym

bearer = HTTPBearer(auto_error=False)
SESSION_LIFETIME = timedelta(days=60)


def current_session(
    request: Request,
    creds: HTTPAuthorizationCredentials | None = Depends(bearer),
    db: Session = Depends(get_db),
) -> AuthSession:
    if creds is None:
        raise HTTPException(status_code=401, detail="not_signed_in")
    session = db.scalar(
        select(AuthSession)
        .options(joinedload(AuthSession.user))
        .where(AuthSession.token_hash == hash_token(creds.credentials))
    )
    now = datetime.now(timezone.utc)
    if session is None or _aware(session.expires_at) <= now:
        raise HTTPException(status_code=401, detail="not_signed_in")
    if _aware(session.expires_at) - now < SESSION_LIFETIME / 2:
        # Someone still using the app stays signed in; only 30 idle days end a sign-in. At most one write a month.
        session.expires_at = now + SESSION_LIFETIME
        db.commit()
    request.state.actor = pseudonym(session.user_id)
    return session


def current_user(session: AuthSession = Depends(current_session), db: Session = Depends(get_db)) -> User:
    user = session.user  # loaded with the session in one query (joined), no second round trip
    if user is None:
        raise HTTPException(status_code=401, detail="not_signed_in")
    return user


def _aware(dt: datetime) -> datetime:
    # SQLite returns naive datetimes; Postgres returns aware ones.
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
