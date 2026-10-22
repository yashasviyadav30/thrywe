"""Light layer search (plan 3.1–3.7).

Flow: shared cache → search.list (100/day bucket) → videos.list for YouTube's own fields → filter rules.
- Search results are cached per normalised query + language for 24 hours, and never used past 30 days (R1).
- Video details are reused for 24 hours, then refetched (1 unit per 50 videos).
- When the day's search quota is used up, cached results are served (even stale ones under 30 days) with a
  note, and the app keeps working (R12).
"""

import hashlib
import json
import logging
import math
import re
import time
from collections.abc import Callable
from dataclasses import asdict, dataclass, field, replace
from datetime import datetime, timedelta, timezone
from functools import lru_cache

import httpx
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app import quota
from app.filters import UserRules, judge
from app.llm import LLMError
from app.models import YtSearchCache, YtVideo
from app.youtube import QuotaExceeded, YouTubeClient, YouTubeError

log = logging.getLogger(__name__)

SEARCH_FRESH = timedelta(hours=24)
DETAILS_FRESH = timedelta(hours=24)
MAX_AGE = timedelta(days=30)
SEARCH_RESULTS = 50  # one search.list call either way; 25 often left too few lectures after the hide rules

# YouTube's site corrects spelling ("Showing results for…"); the API doesn't, so one typo lost the lecture.
# The LLM sees only the user's own words, never a video (R3, R4).
FIX_SYSTEM = """You fix typing mistakes in a YouTube search typed by a student in India.
Answer as JSON: {"q": "<the search>"}.
Correct misspelt words, subjects, exam and paper names, codes and teacher names. Keep the user's language (English,
Hindi or Hinglish), word order and meaning. Never add topics, channels, teachers or extra words. If nothing is
misspelt, return the search unchanged."""


@lru_cache(maxsize=2048)
def _fixed(query: str, llm) -> str:
    return str(json.loads(llm(FIX_SYSTEM, query))["q"])


def fix_typos(query: str, llm) -> str:
    """The search with its typos fixed. Never fails: on any trouble the user's own words are searched."""
    try:
        fixed = " ".join(_fixed(normalise(query), llm).split())[:200]
    except (LLMError, httpx.HTTPError, ValueError, KeyError, TypeError) as e:
        log.warning("typo fix skipped: %s", type(e).__name__)
        return query
    # A rewrite much longer than the search is the model adding things, not fixing spelling.
    if not fixed or len(fixed) > 2 * len(query) + 20 or normalise(fixed) == normalise(query):
        return query
    return fixed


def normalise(query: str) -> str:
    return re.sub(r"\s+", " ", query.casefold()).strip()


def cache_key(query: str, language: str) -> str:
    return hashlib.sha256(f"{normalise(query)}|{language}".encode()).hexdigest()


def _aware(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


@dataclass
class SearchOutcome:
    mode: str  # "live" | "cache" | "cache_stale" | "quota_exhausted"
    results: list[dict] = field(default_factory=list)
    hidden: list[dict] = field(default_factory=list)
    searches_left: int = 0
    timings_ms: dict[str, int] = field(default_factory=dict)
    note: str | None = None
    searched_for: str | None = None  # the typo-fixed search, when it differs from what was typed


def video_card(v: YtVideo) -> dict:
    return {
        "video_id": v.video_id,
        "title": v.title,
        "channel_id": v.channel_id,
        "channel_title": v.channel_title,
        "thumbnail_url": v.thumbnail_url,
        "duration_s": v.duration_s,
        "published_at": v.published_at.isoformat() if v.published_at else None,
        "live": v.live,
        "has_captions": v.has_captions,
    }


def _ids_for(
    db: Session, yt: YouTubeClient, query: str, language: str, now: datetime, max_results: int = 25
) -> tuple[list[str], str]:
    key = cache_key(query, language)
    cached = db.get(YtSearchCache, key)
    if cached and now - _aware(cached.fetched_at) < SEARCH_FRESH:
        return list(cached.video_ids), "cache"
    if quota.search_left(db) > 0:
        try:
            ids = yt.search(query, language, max_results)
        except QuotaExceeded:
            ids = None
        if ids is not None:
            quota.record(db, "search")
            if cached:
                cached.video_ids, cached.fetched_at = ids, now
            else:
                db.add(YtSearchCache(key=key, video_ids=ids, fetched_at=now))
            try:
                db.commit()
            except IntegrityError:
                db.rollback()  # two requests cached the same search at once; the other saved it
            return ids, "live"
    if cached and now - _aware(cached.fetched_at) < MAX_AGE:
        return list(cached.video_ids), "cache_stale"
    return [], "quota_exhausted"


def _details(db: Session, yt: YouTubeClient, ids: list[str], now: datetime) -> dict[str, YtVideo]:
    rows = {v.video_id: v for v in db.scalars(select(YtVideo).where(YtVideo.video_id.in_(ids)))} if ids else {}
    stale = [i for i in ids if i not in rows or now - _aware(rows[i].fetched_at) >= DETAILS_FRESH]
    if stale:
        try:
            fetched = yt.videos(stale)
        except (QuotaExceeded, YouTubeError):
            fetched = None  # YouTube can't refresh right now: keep showing what we have (under 30 days, R12)
    if stale and fetched is not None:
        quota.record(db, "general", math.ceil(len(stale) / 50))
        for f in fetched:
            row = rows.get(f.video_id)  # already loaded above; no extra round trip per video
            values = asdict(f)
            if row is None:
                row = YtVideo(**values, fetched_at=now)
                db.add(row)
            else:
                for k, v in values.items():
                    setattr(row, k, v)
                row.fetched_at = now
            rows[f.video_id] = row
        db.commit()
    # Never show YouTube data older than 30 days, even if the purge hasn't run yet (R1).
    return {k: v for k, v in rows.items() if now - _aware(v.fetched_at) < MAX_AGE}


def _letters(text: str) -> str:
    return "".join(c for c in text.casefold() if c.isalnum())


def named_channels(query: str, videos) -> set[str]:
    """Channels whose name the user typed. Compares the user's own words with channel names only (R3: never titles)."""
    typed = _letters(query)
    return {v.channel_id for v in videos if len(name := _letters(v.channel_title or "")) >= 6 and name in typed}


def run_search(
    db: Session,
    yt: YouTubeClient,
    query: str,
    language: str,
    rules: UserRules,
    fix: Callable[[str], str] | None = None,
) -> SearchOutcome:
    now = datetime.now(timezone.utc)
    t0 = time.perf_counter()
    sent = fix(query) if fix else query
    ids, mode = _ids_for(db, yt, sent, language, now, SEARCH_RESULTS)
    t1 = time.perf_counter()
    videos = _details(db, yt, ids, now)
    t2 = time.perf_counter()

    out = SearchOutcome(mode=mode, searched_for=sent if sent != query else None)
    # A channel the user typed by name counts as followed for this search: some teachers file whole courses under
    # "Entertainment" (Chai aur Code's Python course), and "chai aur code python" must still find them.
    rules = replace(rules, trusted_channels=rules.trusted_channels | named_channels(query, videos.values()))
    for vid in ids:
        v = videos.get(vid)
        if v is None:  # removed or private since the search
            continue
        verdict = judge(v, rules)
        if verdict.visible:
            out.results.append(video_card(v))
        else:
            out.hidden.append({**video_card(v), "reasons": verdict.reasons, "playable": verdict.playable})
    t3 = time.perf_counter()

    out.searches_left = quota.search_left(db)
    out.timings_ms = {
        "search": round((t1 - t0) * 1000),
        "details": round((t2 - t1) * 1000),
        "filter": round((t3 - t2) * 1000),
        "total": round((t3 - t0) * 1000),
    }
    if mode == "cache_stale":
        out.note = "Today’s search limit is used up, so these are saved results from earlier."
    elif mode == "quota_exhausted":
        out.note = "Today’s search limit is used up and there are no saved results for this search. Try again tomorrow, or open your feed."
    return out
