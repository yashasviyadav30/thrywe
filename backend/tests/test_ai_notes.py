import json
from datetime import datetime, timedelta, timezone

import pytest

from app import ai_notes, quota
from app.ai_notes import GeminiBusy, clean, run_due, to_seconds
from app.config import get_settings
from app.models import AiNotes, YtVideo
from app.purge import purge
from app.routers import ai_notes as notes_router

NOW = datetime(2026, 10, 5, 12, 0, tzinfo=timezone.utc)
VID = "aircAruvnKk"

ANSWER = json.dumps({
    "summary": "What a neural network is.",
    "brief": "A network of neurons reads digits.\n\nLayers find patterns.",
    "points": [
        {"title": "Digits", "time": "00:04", "short": "Reading digits.", "detail": "Brains do it easily."},
        {"title": "Past the end", "time": "28:35", "short": "Bad time.", "detail": "Gemini guessed."},
    ],
    "mindmap": [
        {"id": "root", "parent": "", "label": "Neural networks", "detail": "", "time": "0:00"},
        {"id": "layers", "parent": "root", "label": "Layers", "detail": "Input to output.", "time": "3:40"},
        {"id": "lost", "parent": "nowhere", "label": "Orphan", "detail": "", "time": "1:02:03"},
    ],
})


def aware(dt):
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def add_video(db, video_id=VID, duration_s=1153, **kw):
    db.add(YtVideo(video_id=video_id, channel_id="UC1", duration_s=duration_s, **kw))
    db.commit()


def test_to_seconds():
    assert to_seconds("12:40") == 760
    assert to_seconds("1:02:03") == 3723
    assert to_seconds("00:04") == 4
    assert to_seconds("abc") is None and to_seconds("12") is None and to_seconds("1:2:3:4") is None


def test_clean_drops_times_past_the_end_and_fixes_orphans():
    out = clean(ANSWER, duration_s=1153)
    assert [p["seconds"] for p in out["points"]] == [4, None]
    nodes = {n["id"]: n for n in out["mindmap"]}
    assert nodes["root"]["parent"] is None
    assert nodes["layers"]["parent"] == "root" and nodes["layers"]["seconds"] == 220
    assert nodes["lost"]["parent"] == "root" and nodes["lost"]["seconds"] is None


def test_clean_rejects_bad_json():
    with pytest.raises(ai_notes.GeminiFailed):
        clean('{"summary": "x"}', None)


def test_job_becomes_ready_and_records_video_seconds(db):
    add_video(db)
    ai_notes.request_notes(db, VID, "en")
    calls = []
    assert run_due(db, datetime.now(timezone.utc), call=lambda v, lang, part=None, seconds=0: calls.append((v, lang)) or ANSWER) == "ready"
    assert calls == [(VID, "en")]
    job = db.get(AiNotes, (VID, "en"))
    assert job.data["summary"] == "What a neural network is."
    assert job.data["brief"].startswith("A network of neurons")
    assert quota.used(db, ai_notes.BUDGET_BUCKET) == 1153
    assert run_due(db, datetime.now(timezone.utc)) is None  # nothing left to do


@pytest.fixture(autouse=True)
def no_retry_waits(monkeypatch):
    monkeypatch.setattr(ai_notes, "RETRY_WAITS", (0, 0))


def test_busy_backs_off_then_gives_up(db):
    add_video(db)
    ai_notes.request_notes(db, VID, "en")
    calls = []

    def busy(v, lang, part=None, seconds=0):
        calls.append(part)
        raise GeminiBusy("HTTP 503")

    t = datetime.now(timezone.utc)
    assert run_due(db, t, call=busy) == "queued"
    assert len(calls) == 3  # asked again twice within the same run before backing off
    job = db.get(AiNotes, (VID, "en"))
    assert job.reason == "busy" and job.attempts == 1
    assert aware(job.next_try_at) - t <= timedelta(minutes=2)  # back soon, not hours later
    assert run_due(db, t, call=busy) is None  # not due yet
    for _ in range(ai_notes.MAX_ATTEMPTS - 1):
        t += timedelta(hours=4)
        status = run_due(db, t, call=busy)
    assert status == "failed"


def test_daily_limit_waits_for_tomorrow_without_calling(db):
    add_video(db, duration_s=3000)
    quota.record(db, ai_notes.BUDGET_BUCKET, get_settings().gemini_video_s_per_day - 100)
    ai_notes.request_notes(db, VID, "hi")
    now = datetime.now(timezone.utc)
    assert run_due(db, now, call=lambda v, lang, part=None, seconds=0: pytest.fail("must not call Gemini")) == "queued"
    job = db.get(AiNotes, (VID, "hi"))
    assert job.reason == "daily_limit" and job.attempts == 0
    assert aware(job.next_try_at) > now
    assert ai_notes.view(job)["starts_at"]


def test_rebuilds_leave_half_the_day_for_new_videos(db):
    add_video(db, duration_s=600)
    quota.record(db, ai_notes.BUDGET_BUCKET, get_settings().gemini_video_s_per_day // 2)
    job = ai_notes.request_notes(db, VID, "en")
    old = {"summary": "old", "points": [], "mindmap": [], "v": 1}
    job.data = {"previous": old}
    db.commit()
    never = lambda v, lang, part=None, seconds=0: pytest.fail("must not call Gemini")  # noqa: E731
    assert run_due(db, datetime.now(timezone.utc), call=never) == "queued"
    assert job.reason == "daily_limit"
    assert ai_notes.view(job) == {"status": "ready", "notes": old, "updating": True}  # the old notes stay open


def part_answer(asked):
    def answer(v, lang, part=None, seconds=0):
        asked.append(part)
        m = (part[0] if part else 0) // 60
        return json.dumps({"summary": f"from {m}", "points": [{"title": "P", "time": f"{m}:05", "short": "s", "detail": "d"}],
                           "mindmap": [{"id": "r", "parent": "", "label": "Root", "detail": "", "time": f"{m}:00"},
                                       {"id": "a", "parent": "r", "label": "A", "detail": "", "time": f"{m}:10"}]})
    return answer


def whole_video(seen):
    """A fake combining call: notes for the whole video, built from the parts it was given."""
    def combine(done, lang, duration):
        seen.append([d["summary"] for d in done])
        return json.dumps({"summary": "The whole talk.", "brief": "One.\n\nTwo.",
                           "points": [{"title": "Start", "time": "0:05", "short": "s", "detail": "d"},
                                      {"title": "Late", "time": "1:00:05", "short": "s", "detail": "d"}],
                           "mindmap": [{"id": "r", "parent": "", "label": "Talk", "detail": "", "time": "0:00"},
                                       {"id": "t", "parent": "r", "label": "Theme", "detail": "", "time": "15:10"}]})
    return combine


def test_long_video_is_read_in_15_minute_parts_then_combined(db):
    add_video(db, duration_s=3600 + 600)  # 70 minutes: five parts
    ai_notes.request_notes(db, VID, "en")
    asked, seen = [], []
    assert run_due(db, datetime.now(timezone.utc), call=part_answer(asked), combine=whole_video(seen)) == "ready"
    assert sorted(asked) == [(0, 900), (900, 1800), (1800, 2700), (2700, 3600), (3600, 4200)]
    assert seen == [["from 0", "from 15", "from 30", "from 45", "from 60"]]  # in order
    data = db.get(AiNotes, (VID, "en")).data
    assert data["summary"] == "The whole talk." and [p["seconds"] for p in data["points"]] == [5, 3605]
    assert quota.used(db, ai_notes.BUDGET_BUCKET) == 4200


def test_a_failed_combine_keeps_the_parts_and_is_tried_again(db):
    add_video(db, duration_s=1800 + 60)
    ai_notes.request_notes(db, VID, "en")

    def broken(done, lang, duration):
        raise GeminiBusy("HTTP 503")

    t = datetime.now(timezone.utc)
    assert run_due(db, t, call=part_answer([]), combine=broken) == "queued"  # not the rough merge yet
    assert len(db.get(AiNotes, (VID, "en")).data["parts"]) == 3
    never = lambda v, lang, part=None, seconds=0: pytest.fail("the parts are kept")  # noqa: E731
    assert run_due(db, t + timedelta(minutes=6), call=never, combine=whole_video([])) == "ready"
    assert db.get(AiNotes, (VID, "en")).data["summary"] == "The whole talk."
    assert quota.used(db, ai_notes.BUDGET_BUCKET) == 1860  # the video counted once


def test_combining_falls_back_to_a_plain_merge_when_it_keeps_failing(db):
    add_video(db, duration_s=1800 + 60)
    ai_notes.request_notes(db, VID, "en")

    def broken(done, lang, duration):
        raise GeminiBusy("HTTP 503")

    t = datetime.now(timezone.utc) + ai_notes.REMAKE_DELAY
    for _ in range(ai_notes.MAX_ATTEMPTS):
        status = run_due(db, t, call=part_answer([]), combine=broken)
        t += timedelta(minutes=6)
    assert status == "ready"
    data = db.get(AiNotes, (VID, "en")).data
    assert data["brief"].split("\n\n") == ["Part 1. from 0", "Part 2. from 15", "Part 3. from 30"]
    assert {n["id"]: n for n in data["mindmap"]}["p2-r"]["label"] == "Part 2: Root"


def test_finished_parts_are_kept_and_only_failed_ones_are_asked_again(db, signed_in):
    add_video(db, duration_s=2700)  # three parts
    ai_notes.request_notes(db, VID, "en")
    asked = []
    answer = part_answer(asked)

    def second_part_busy(v, lang, part=None, seconds=0):
        if part == (900, 1800):
            raise GeminiBusy("HTTP 503")
        return answer(v, lang, part, seconds)

    t = datetime.now(timezone.utc)
    assert run_due(db, t, call=second_part_busy) == "queued"
    peek = signed_in.post("/api/ai-notes", json={"video_id": VID, "create": False}).json()
    assert peek["progress"] == {"done": 2, "total": 3}  # the page can say "2 of 3 parts"
    # The first part is ready from the start: shown now as a preview of the first 15 minutes.
    assert peek["covered_s"] == 900 and peek["partial"]["summary"] == "from 0"
    asked.clear()
    assert run_due(db, t + timedelta(hours=1), call=answer, combine=whole_video([])) == "ready"
    assert asked == [(900, 1800)]


def test_preview_summary_keeps_one_parts_length_while_the_parts_are_combined(db, signed_in):
    add_video(db, duration_s=2700)  # three parts
    ai_notes.request_notes(db, VID, "en")

    def busy(*_args, **_kwargs):
        raise GeminiBusy("HTTP 503")

    t = datetime.now(timezone.utc)
    assert run_due(db, t, call=part_answer([]), combine=busy) == "queued"
    assert aware(db.get(AiNotes, (VID, "en")).next_try_at) - t == ai_notes.COMBINE_RETRY  # a minute, not five
    peek =signed_in.post("/api/ai-notes", json={"video_id": VID, "create": False}).json()
    assert peek["covered_s"] == 2700
    assert peek["partial"]["summary"] == "from 0"  # not "from 0 from 15 from 30"
    assert peek["partial"]["brief"].split("\n\n") == ["Part 1. from 0", "Part 2. from 15", "Part 3. from 30"]


def test_summary_grows_with_the_video():
    assert ai_notes.summary_words(10 * 60).startswith("6 to 8 sentences")
    assert ai_notes.summary_words(35 * 60).startswith("8 to 11 sentences")
    assert ai_notes.summary_words(3 * 3600).startswith("13 to 18 sentences")
    assert ai_notes.brief_words(3 * 3600).startswith("10 to 13 sections")


def test_twenty_minute_video_is_one_call(db):
    add_video(db, duration_s=20 * 60)
    ai_notes.request_notes(db, VID, "en")
    asked = []
    run_due(db, datetime.now(timezone.utc), call=part_answer(asked))
    assert asked == [None]


def test_too_long_video_is_refused(db):
    add_video(db, duration_s=7 * 3600)
    ai_notes.request_notes(db, VID, "en")
    assert run_due(db, datetime.now(timezone.utc), call=lambda v, lang, part=None, seconds=0: pytest.fail("must not call Gemini")) == "too_long"


def test_endpoint_shares_one_job_between_users(signed_in, db):
    notes_router._new_jobs.clear()
    assert signed_in.post("/api/ai-notes", json={"video_id": VID}).status_code == 404  # never shown by the app
    add_video(db)
    assert signed_in.post("/api/ai-notes", json={"video_id": VID, "create": False}).json() == {"status": "none"}
    assert db.query(AiNotes).count() == 0
    r = signed_in.post("/api/ai-notes", json={"video_id": VID, "lang": "en"})
    assert r.json() == {"status": "queued", "reason": None}
    run_due(db, datetime.now(timezone.utc), call=lambda v, lang, part=None, seconds=0: ANSWER)
    r = signed_in.post("/api/ai-notes", json={"video_id": VID, "lang": "en"})
    assert r.json()["status"] == "ready" and r.json()["notes"]["points"][0]["seconds"] == 4
    assert db.query(AiNotes).count() == 1


def test_endpoint_checks_input_and_limits_new_jobs(signed_in, db):
    notes_router._new_jobs.clear()
    assert signed_in.post("/api/ai-notes", json={"video_id": VID, "lang": "fr"}).status_code == 422
    assert signed_in.post("/api/ai-notes", json={"video_id": "bad"}).status_code == 422
    ids = [f"vid{i:08d}" for i in range(notes_router.NEW_JOBS_PER_USER_DAY + 1)]
    for v in ids:
        add_video(db, video_id=v)
    codes = [signed_in.post("/api/ai-notes", json={"video_id": v}).status_code for v in ids]
    assert codes[:-1] == [200] * notes_router.NEW_JOBS_PER_USER_DAY and codes[-1] == 429


def test_endpoint_says_unavailable_without_a_gemini_key(signed_in, db, monkeypatch):
    monkeypatch.setattr(get_settings(), "gemini_api_key", "")
    add_video(db)
    assert signed_in.post("/api/ai-notes", json={"video_id": VID}).json() == {"status": "unavailable"}
    assert db.query(AiNotes).count() == 0


def test_endpoint_needs_sign_in(client):
    assert client.post("/api/ai-notes", json={"video_id": VID}).status_code == 401


def test_purge_deletes_ai_notes_after_30_days(db):
    db.add_all([AiNotes(video_id="old________", lang="en", updated_at=NOW - timedelta(days=31)),
                AiNotes(video_id="new________", lang="en", updated_at=NOW - timedelta(days=1))])
    db.commit()
    assert purge(db, now=NOW)["ai_notes"] == 1


def test_try_again_requeues_a_failed_summary(signed_in, db):
    add_video(db)
    ai_notes.request_notes(db, VID, "en")
    job = db.get(AiNotes, (VID, "en"))
    job.status, job.attempts = "failed", ai_notes.MAX_ATTEMPTS
    db.commit()
    assert signed_in.post("/api/ai-notes", json={"video_id": VID, "create": False}).json()["status"] == "failed"
    assert signed_in.post("/api/ai-notes", json={"video_id": VID, "create": True}).json()["status"] == "queued"
    db.refresh(job)
    assert job.attempts == 0


def test_a_part_time_counted_from_the_part_is_moved_into_the_part():
    raw = json.dumps({"summary": "s", "points": [{"title": "Bayes", "time": "1:30", "short": "s", "detail": "d"},
                                                 {"title": "Right", "time": "1:01:10", "short": "s", "detail": "d"}],
                      "mindmap": [{"id": "r", "parent": "", "label": "R", "detail": "", "time": "2:00"}]})
    notes = clean(raw, 4 * 3600, part=(3600, 4500))
    assert [p["seconds"] for p in notes["points"]] == [3690, 3670]
    assert notes["mindmap"][0]["seconds"] == 3720


def test_an_older_format_opens_at_once_while_the_new_one_is_made(signed_in, db):
    add_video(db)
    old = {"summary": "Old one-liner.", "points": [], "mindmap": []}  # format 1: no "v"
    db.add(AiNotes(video_id=VID, lang="en", status="ready", data=old))
    db.commit()
    peek = signed_in.post("/api/ai-notes", json={"video_id": VID, "create": False}).json()
    assert peek["status"] == "ready" and peek["notes"] == old and peek["updating"] is True  # no waiting screen
    later = datetime.now(timezone.utc) + ai_notes.REMAKE_DELAY
    assert run_due(db, later, call=lambda v, lang, part=None, seconds=0: ANSWER) == "ready"
    new = signed_in.post("/api/ai-notes", json={"video_id": VID, "create": False}).json()
    assert new["notes"]["v"] == ai_notes.NOTES_VERSION and "updating" not in new


def test_a_new_video_is_made_before_a_remake_asked_just_before_it(signed_in, db):
    add_video(db)
    add_video(db, video_id="newvideo001")
    db.add(AiNotes(video_id=VID, lang="en", status="ready", data={"summary": "Old.", "points": [], "mindmap": []}))
    db.commit()
    signed_in.post("/api/ai-notes", json={"video_id": VID, "create": False})  # an old summary opened: remake queued
    ai_notes.request_notes(db, "newvideo001", "en")  # then someone asks for a new video
    asked = []

    def answer(v, lang, part=None, seconds=0):
        asked.append(v)
        return ANSWER

    run_due(db, datetime.now(timezone.utc), call=answer)
    assert asked == ["newvideo001"]


def test_if_the_new_format_never_comes_the_old_notes_stay(signed_in, db):
    add_video(db)
    old = {"summary": "Old.", "points": [], "mindmap": []}
    db.add(AiNotes(video_id=VID, lang="en", status="ready", data=old))
    db.commit()
    signed_in.post("/api/ai-notes", json={"video_id": VID, "create": False})

    def busy(v, lang, part=None, seconds=0):
        raise GeminiBusy("HTTP 503")

    t = datetime.now(timezone.utc) + ai_notes.REMAKE_DELAY
    for _ in range(ai_notes.MAX_ATTEMPTS):
        status = run_due(db, t, call=busy)
        t += timedelta(hours=1)
    assert status == "ready" and db.get(AiNotes, (VID, "en")).data == old


def test_googles_daily_limit_waits_for_the_reset_without_failing(db):
    add_video(db, duration_s=600)
    ai_notes.request_notes(db, VID, "en")

    def out_for_the_day(v, lang, part=None, seconds=0):
        raise ai_notes.GeminiDailyLimit("HTTP 429 per day")

    # Noon in California, so the reset is hours away whatever time the test runs.
    now = ai_notes._next_pacific_midnight(datetime.now(timezone.utc)) + timedelta(hours=12)
    for _ in range(ai_notes.MAX_ATTEMPTS + 1):
        assert run_due(db, now, call=out_for_the_day) == "queued"
        job = db.get(AiNotes, (VID, "en"))
        assert job.reason == "daily_limit" and aware(job.next_try_at) > now + timedelta(minutes=30)
        now = aware(job.next_try_at)
