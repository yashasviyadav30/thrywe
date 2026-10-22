"""AI notes and mind map for the study page. Video IDs travel in the body, never the URL (R11)."""

from collections import defaultdict
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app import ai_notes, quota
from app.auth import current_user
from app.config import get_settings
from app.db import get_db
from app.models import AiNotes, User, YtVideo
from app.routers.study import VIDEO_ID

router = APIRouter(prefix="/api", tags=["ai-notes"])

# ponytail: in-memory, one instance; move to quota_usage if the app runs on several instances.
NEW_JOBS_PER_USER_DAY = 15
_new_jobs: dict[tuple, int] = defaultdict(int)


class AiNotesIn(BaseModel):
    video_id: str = Field(pattern=VIDEO_ID)
    lang: str = Field(default="en", pattern=r"^(en|hi|auto)$")
    create: bool = True  # False = only look; the page peeks on open and starts a job on "Generate notes"


@router.post("/ai-notes")
def get_or_request(body: AiNotesIn, request: Request, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    """Notes if ready; otherwise starts a shared job (or reports its state). The page polls this."""
    request.state.action = "ai_notes"
    job = db.get(AiNotes, (body.video_id, body.lang))
    if not get_settings().gemini_api_key and (job is None or job.status == "queued"):
        return {"status": "unavailable"}  # no key on this server: say so instead of queueing forever
    if job is None and not body.create:
        return {"status": "none"}
    if job is None:
        video = db.get(YtVideo, body.video_id)  # only videos the app already showed (R5 filters ran on them)
        if video is None or not video.embeddable or video.age_restricted:
            raise HTTPException(status_code=404, detail="video_unknown")
        key = (user.id, quota.quota_day())
        if _new_jobs[key] >= NEW_JOBS_PER_USER_DAY:
            raise HTTPException(status_code=429, detail="too_many_notes_today")
        _new_jobs[key] += 1
        job = ai_notes.request_notes(db, body.video_id, body.lang)
        ai_notes.wake()
    elif job.status == "ready" and (job.data or {}).get("v", 1) < ai_notes.NOTES_VERSION:
        # Made in an older, thinner format: make it again in the new one, and keep showing the old notes meanwhile.
        job.status, job.data, job.attempts, job.reason = "queued", {"previous": job.data}, 0, None
        job.next_try_at = datetime.now(timezone.utc) + ai_notes.REMAKE_DELAY  # a new video asked meanwhile goes first
        db.commit()
        ai_notes.wake()
    elif job.status == "failed" and body.create:  # "Try again": Gemini's bad hours shouldn't fail a video for good
        job.status, job.attempts, job.reason, job.next_try_at = "queued", 0, None, datetime.now(timezone.utc)
        db.commit()
        ai_notes.wake()
    return ai_notes.view(job)
