"""POST /api/search, plus the user's own rules: mutes and followed teachers."""

import re
from collections.abc import Callable

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app import google, quota
from app.auth import current_user
from app.config import get_settings
from app.db import get_db
from app.feed import build_feed, build_shorts
from app.filters import UserRules
from app.filters import DEFAULT_HIDDEN_GROUPS
from app.models import Follow, Goal, LectureProgress, Mute, NotInterested, User, YtVideo
from app.routers.study import VIDEO_ID
from app.routers.goals import view
from app.llm import groq_json
from app.search import fix_typos, run_search
from app.youtube import YouTubeClient, YouTubeError

router = APIRouter(prefix="/api", tags=["search"])

CHANNEL_ID = re.compile(r"^UC[0-9A-Za-z_-]{22}$")
LANGUAGES = {"en", "hi"}


def get_youtube() -> YouTubeClient:
    key = get_settings().youtube_api_key
    if not key:
        raise HTTPException(status_code=503, detail="youtube_not_configured")
    return YouTubeClient(key)


def get_typo_fixer() -> Callable[[str], str] | None:
    """Fixes spelling in the user's own search (R4); none without an LLM, and the words go as typed."""
    if get_settings().groq_api_key:
        return lambda q: fix_typos(q, groq_json)
    return None


def rules_for(db: Session, user: User) -> UserRules:
    mutes = list(db.scalars(select(Mute).where(Mute.user_id == user.id)))
    follows = set(db.scalars(select(Follow.channel_id).where(Follow.user_id == user.id)))
    s = user.settings
    return UserRules(
        muted_channels={m.value for m in mutes if m.kind == "channel"},
        muted_phrases=[m.value for m in mutes if m.kind == "phrase"],
        shorts_enabled=False,  # Shorts live in their own tab (plan v3), never in the feed or search results
        trusted_channels=follows,
        hidden_groups=DEFAULT_HIDDEN_GROUPS if not s or s.hidden_groups is None else frozenset(s.hidden_groups),
        not_interested=set(db.scalars(select(NotInterested.video_id).where(NotInterested.user_id == user.id))),
    )


def progress_for(db: Session, user: User, ids: list[str]) -> dict[str, int]:
    """Where the user stopped in each of these videos, for the red line under the thumbnail (our data, R9)."""
    if not ids:
        return {}
    rows = db.execute(select(LectureProgress.video_id, LectureProgress.position_s)
                      .where(LectureProgress.user_id == user.id, LectureProgress.video_id.in_(ids)))
    return dict(rows.all())


def watched_channels(db: Session, user: User, skip: set[str], limit: int = 4) -> list[str]:
    """Channels of videos the user watched here recently: the feed treats them like soft follows."""
    rows = db.scalars(select(YtVideo.channel_id).join(LectureProgress, LectureProgress.video_id == YtVideo.video_id)
                      .where(LectureProgress.user_id == user.id).order_by(LectureProgress.updated_at.desc()).limit(30))
    return [c for c in dict.fromkeys(rows) if c not in skip][:limit]


class SearchIn(BaseModel):
    # In the body, not the URL, so search text never reaches any request log (R11).
    q: str = Field(min_length=1, max_length=200)
    language: str | None = None
    exact: bool = False  # "Search for … instead": the words as typed, no typo fix


@router.post("/search")
def search(
    body: SearchIn,
    request: Request,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
    yt: YouTubeClient = Depends(get_youtube),
    fix: Callable[[str], str] | None = Depends(get_typo_fixer),
) -> dict:
    request.state.action = "search"
    language = body.language if body.language in LANGUAGES else (user.settings.search_language if user.settings else "en")
    try:
        out = run_search(db, yt, body.q, language, rules_for(db, user), None if body.exact else fix)
    except YouTubeError:
        raise HTTPException(status_code=502, detail="youtube_unavailable") from None
    return {
        "mode": out.mode,
        "results": out.results,
        "hidden": out.hidden,
        "hidden_count": len(out.hidden),
        "searches_left": out.searches_left,
        "note": out.note,
        "searched_for": out.searched_for,
        "timings_ms": out.timings_ms,
        "progress": progress_for(db, user, [r["video_id"] for r in out.results]),
    }


class MuteIn(BaseModel):
    kind: str = Field(pattern="^(channel|phrase)$")
    value: str = Field(min_length=2, max_length=200)


class FollowIn(BaseModel):
    channel_id: str


@router.get("/mutes")
def list_mutes(user: User = Depends(current_user), db: Session = Depends(get_db)) -> list[dict]:
    return [{"kind": m.kind, "value": m.value} for m in db.scalars(select(Mute).where(Mute.user_id == user.id))]


@router.post("/mutes", status_code=201)
def add_mute(body: MuteIn, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    value = body.value.strip()
    if body.kind == "channel" and not CHANNEL_ID.match(value):
        raise HTTPException(status_code=422, detail="invalid_channel_id")
    db.add(Mute(user_id=user.id, kind=body.kind, value=value))
    try:
        db.commit()
    except IntegrityError:
        db.rollback()  # already muted: fine
    return {"kind": body.kind, "value": value}


@router.post("/mutes/remove", status_code=204)
def remove_mute(body: MuteIn, user: User = Depends(current_user), db: Session = Depends(get_db)) -> None:
    db.execute(delete(Mute).where(Mute.user_id == user.id, Mute.kind == body.kind, Mute.value == body.value.strip()))
    db.commit()


class ImportIn(BaseModel):
    # A short-lived token from Google, used once and never stored.
    access_token: str = Field(min_length=20, max_length=4096)


@router.post("/follows/import")
def import_follows(body: ImportIn, request: Request, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    """Follow every channel the user subscribes to on YouTube (plan v3). The user can unfollow any of them later."""
    request.state.action = "follows_import"
    try:
        channels = [c for c in dict.fromkeys(google.subscription_channels(body.access_token)) if CHANNEL_ID.match(c)]
    except google.GoogleError as e:
        raise HTTPException(status_code=400 if str(e) == "google_denied" else 502, detail=str(e)) from None
    quota.record(db, "general", max(1, -(-len(channels) // 50)))
    have = set(db.scalars(select(Follow.channel_id).where(Follow.user_id == user.id)))
    new = [c for c in channels if c not in have]
    db.add_all(Follow(user_id=user.id, channel_id=c) for c in new)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()  # a double tap: the other request saved them
    return {"imported": len(new), "subscriptions": len(channels)}


@router.get("/follows")
def list_follows(user: User = Depends(current_user), db: Session = Depends(get_db)) -> list[str]:
    return list(db.scalars(select(Follow.channel_id).where(Follow.user_id == user.id)))


@router.post("/follows", status_code=201)
def add_follow(body: FollowIn, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    if not CHANNEL_ID.match(body.channel_id):
        raise HTTPException(status_code=422, detail="invalid_channel_id")
    db.add(Follow(user_id=user.id, channel_id=body.channel_id))
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
    return {"channel_id": body.channel_id}


@router.post("/follows/remove", status_code=204)
def remove_follow(body: FollowIn, user: User = Depends(current_user), db: Session = Depends(get_db)) -> None:
    db.execute(delete(Follow).where(Follow.user_id == user.id, Follow.channel_id == body.channel_id))
    db.commit()


class FeedIn(BaseModel):
    # Their last searches, kept on their phone (never stored here) and sent in the body (R11).
    recent: list[str] = Field(default_factory=list, max_length=5)
    only: str | None = Field(default=None, pattern=r"^podcasts$")  # the shared "Podcasts & talks" chip


@router.get("/feed")
def feed_get(request: Request, user: User = Depends(current_user), db: Session = Depends(get_db),
             yt: YouTubeClient = Depends(get_youtube)) -> dict:
    return feed(FeedIn(), request, user, db, yt)


@router.post("/feed")
def feed(body: FeedIn, request: Request, user: User = Depends(current_user), db: Session = Depends(get_db),
         yt: YouTubeClient = Depends(get_youtube)) -> dict:
    """Home feed: followed and recently watched channels, their goal's topics and their recent searches."""
    request.state.action = "feed"
    row = db.scalar(select(Goal).where(Goal.user_id == user.id, Goal.active.is_(True)).order_by(Goal.created_at.desc()))
    goal = view(row) if row else None
    rules = rules_for(db, user)
    follows = list(db.scalars(select(Follow.channel_id).where(Follow.user_id == user.id).order_by(Follow.id.desc())))
    channels = follows + watched_channels(db, user, set(follows) | rules.muted_channels)
    recent = [q.strip()[:200] for q in body.recent if q.strip()]
    language = user.settings.search_language if user.settings else "en"
    try:
        out = build_feed(db, yt, rules, channels, goal["query"] if goal else None,
                         [t["query"] for t in goal["topics"]] if goal else [], language, recent, body.only)
    except YouTubeError:
        raise HTTPException(status_code=502, detail="youtube_unavailable") from None
    return out | {"progress": progress_for(db, user, [r["video_id"] for r in out["results"]])}


@router.get("/shorts")
def shorts(request: Request, user: User = Depends(current_user), db: Session = Depends(get_db),
           yt: YouTubeClient = Depends(get_youtube)) -> dict:
    """Shorts only from channels the user follows (plan v3): the useful reels, without the endless scroll of strangers."""
    request.state.action = "shorts"
    follows = list(db.scalars(select(Follow.channel_id).where(Follow.user_id == user.id).order_by(Follow.id.desc())))
    try:
        return build_shorts(db, yt, rules_for(db, user), follows)
    except YouTubeError:
        raise HTTPException(status_code=502, detail="youtube_unavailable") from None


class NotInterestedIn(BaseModel):
    video_id: str = Field(pattern=VIDEO_ID)
    undo: bool = False


@router.post("/videos/not-interested", status_code=204)
def not_interested(body: NotInterestedIn, user: User = Depends(current_user), db: Session = Depends(get_db)) -> None:
    if body.undo:
        db.execute(delete(NotInterested).where(NotInterested.user_id == user.id, NotInterested.video_id == body.video_id))
    else:
        db.add(NotInterested(user_id=user.id, video_id=body.video_id))
    try:
        db.commit()
    except IntegrityError:
        db.rollback()  # already marked
