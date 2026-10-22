from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select

from app.config import get_settings
from app.filters import CATEGORY_GROUPS, UserRules, judge, youtube_type_reason
from app.models import AppLog, YtSearchCache, YtVideo
from app.llm import LLMError
from app.routers.search import get_typo_fixer, get_youtube
from app.search import fix_typos
from app.youtube import blocked_in, parse_duration, parse_video
from tests.fake_youtube import FakeYouTube, video

TEACHER = "UC" + "a" * 22
SINGER = "UC" + "b" * 22


@pytest.fixture()
def yt(signed_in):
    fake = FakeYouTube(
        results={
            "cost accounting": ["lecture0001", "musicvid001", "agerestrict", "noembed0001", "shortvid001", "blockedIN01", "shortlesson"],
        },
        videos={
            "lecture0001": video("lecture0001"),
            "musicvid001": video("musicvid001", channel_id=SINGER, category_id="10", title="New song"),
            "agerestrict": video("agerestrict", age_restricted=True),
            "noembed0001": video("noembed0001", embeddable=False),
            "shortvid001": video("shortvid001", duration_s=45, vertical=True),
            "shortlesson": video("shortlesson", duration_s=120, vertical=False),
            "blockedIN01": video("blockedIN01", blocked_in_india=True),
        },
    )
    signed_in.app.dependency_overrides[get_youtube] = lambda: fake
    signed_in.app.dependency_overrides[get_typo_fixer] = lambda: None  # tests never call a real LLM
    return fake


# ---------- typos (YouTube's site fixes spelling; the API doesn't) ----------

def fake_llm(answer):
    def llm(system, user):
        assert "typing mistakes" in system and user == "cost acounting"  # only the user's own words go out (R4)
        return answer
    return llm


def test_a_typo_is_fixed_before_searching_and_the_page_says_so(yt, signed_in):
    llm = fake_llm('{"q": "cost accounting"}')
    signed_in.app.dependency_overrides[get_typo_fixer] = lambda: (lambda q: fix_typos(q, llm))
    body = signed_in.post("/api/search", json={"q": "cost acounting"}).json()
    assert yt.search_calls == [("cost accounting", "en")]
    assert body["searched_for"] == "cost accounting"
    assert [v["video_id"] for v in body["results"]][:1] == ["lecture0001"]
    # "Search for … instead" sends the words as typed
    body = signed_in.post("/api/search", json={"q": "cost acounting", "exact": True}).json()
    assert yt.search_calls[-1] == ("cost acounting", "en") and body["searched_for"] is None


def test_typo_fix_never_breaks_or_bloats_a_search():
    def broken(system, user):
        raise LLMError("HTTP 503")
    assert fix_typos("cost acounting", broken) == "cost acounting"
    assert fix_typos("cost acounting", fake_llm("not json")) == "cost acounting"
    assert fix_typos("cost acounting", fake_llm('{"q": "cost accounting full course by the best teachers in india 2026 hindi"}')) == "cost acounting"
    assert fix_typos("cost acounting", fake_llm('{"q": "Cost Acounting"}')) == "cost acounting"  # unchanged: no note


# ---------- parsing YouTube's fields ----------


def test_parse_duration():
    assert parse_duration("PT1H2M3S") == 3723
    assert parse_duration("PT45S") == 45
    assert parse_duration("P1DT1M") == 86460
    assert parse_duration("P0D") == 0
    assert parse_duration(None) is None


def test_region_restriction():
    assert blocked_in({"blocked": ["IN", "PK"]})
    assert not blocked_in({"blocked": ["US"]})
    assert blocked_in({"allowed": ["US"]})
    assert not blocked_in({"allowed": ["IN"]})
    assert not blocked_in(None)


def test_parse_video_reads_only_youtube_fields():
    v = parse_video({
        "id": "abcdefghijk",
        "snippet": {"channelId": TEACHER, "title": "T", "categoryId": "27", "liveBroadcastContent": "none",
                    "thumbnails": {"medium": {"url": "https://i.ytimg.com/m.jpg"}}},
        "contentDetails": {"duration": "PT10M", "contentRating": {"ytRating": "ytAgeRestricted"},
                           "regionRestriction": {"blocked": ["IN"]}, "caption": "true"},
        "status": {"embeddable": False, "madeForKids": True},
        "player": {"embedWidth": "405", "embedHeight": "720"},
        "topicDetails": {"topicCategories": ["https://en.wikipedia.org/wiki/Music"]},
    })
    assert (v.duration_s, v.age_restricted, v.embeddable, v.made_for_kids, v.blocked_in_india, v.has_captions) == (600, True, False, True, True, True)
    assert v.category_id == "27" and v.topic_categories == ["https://en.wikipedia.org/wiki/Music"]
    assert v.vertical is True


# ---------- filter rules ----------


def test_youtube_type_reason():
    everything = frozenset(CATEGORY_GROUPS)
    assert youtube_type_reason("24", []) == "YouTube lists this as Entertainment"
    assert youtube_type_reason("20", []) == "YouTube lists this as Gaming"
    assert youtube_type_reason("10", []) == "YouTube lists this as Music"  # songs hidden by default
    assert youtube_type_reason("10", [], frozenset({"gaming"})) is None  # unless the user switches Music on
    assert youtube_type_reason("10", [], everything) == "YouTube lists this as Music"
    assert youtube_type_reason("27", ["https://en.wikipedia.org/wiki/Humour"]) is None  # Education wins
    assert youtube_type_reason("22", ["https://en.wikipedia.org/wiki/Humour"]) == "YouTube tags this as Comedy"
    assert youtube_type_reason("22", ["https://en.wikipedia.org/wiki/Pop_music"], everything) == "YouTube tags this as Music"
    assert youtube_type_reason("22", ["https://en.wikipedia.org/wiki/Knowledge"], everything) is None
    assert youtube_type_reason("35", [], everything) is None  # documentaries stay


def test_default_hide_list_is_gaming_comedy_and_entertainment():
    for cat in ("20", "23", "24", "43", "10"):
        assert not judge(video("x" * 11, category_id=cat), UserRules()).visible, cat
    # Films, news and vlogs are their choice; podcasts and lectures always show.
    for cat in ("1", "25", "19", "22", "27", "28", "26", "35", "17"):
        assert judge(video("x" * 11, category_id=cat), UserRules()).visible, cat


def test_hidden_groups_and_not_interested():
    assert not judge(video("x" * 11, category_id="25"), UserRules(hidden_groups=frozenset({"news"}))).visible
    assert judge(video("x" * 11, category_id="20"), UserRules(hidden_groups=frozenset())).visible
    verdict = judge(video("n" * 11, category_id="27"), UserRules(not_interested={"n" * 11}))
    assert not verdict.visible and verdict.reasons == ["You said not interested"]


def test_no_built_in_channel_list_overrides_the_filter():
    import inspect

    from app.routers import search as search_router

    assert "curated" not in inspect.getsource(search_router.rules_for)


def test_trusted_channels_are_never_hidden_by_youtube_type():
    lecture_in_entertainment = video("x" * 11, category_id="24")
    assert not judge(lecture_in_entertainment, UserRules()).visible
    assert judge(lecture_in_entertainment, UserRules(trusted_channels={TEACHER})).visible


def test_drop_rules_beat_trust():
    v = video("x" * 11, age_restricted=True)
    verdict = judge(v, UserRules(trusted_channels={TEACHER}))
    assert not verdict.visible and not verdict.playable


def test_phrase_mute_and_shorts_setting():
    v = video("x" * 11, title="Bigg Boss highlights", duration_s=60, vertical=True)
    verdict = judge(v, UserRules(muted_phrases=["bigg boss"]))
    assert "Your mute: “bigg boss”" in verdict.reasons
    assert any("in the Shorts tab" in r for r in verdict.reasons)
    assert judge(video("y" * 11, duration_s=60, vertical=True), UserRules(shorts_enabled=True)).visible
    assert judge(video("z" * 11, duration_s=60, vertical=False), UserRules()).visible  # short lesson, not a Short
    assert judge(video("w" * 11, duration_s=60, vertical=None), UserRules()).visible  # unknown shape: show


# ---------- the search endpoint ----------


def test_search_shows_learning_and_explains_every_hidden_video(yt, signed_in):
    # The user hides music and news themselves (they show by default since plan v3).
    signed_in.post("/api/me/settings", json={"hidden_groups": ["music", "news", "gaming", "comedy", "entertainment"]})
    r = signed_in.post("/api/search", json={"q": "cost accounting"})
    assert r.status_code == 200
    body = r.json()
    assert [v["video_id"] for v in body["results"]] == ["lecture0001", "shortlesson"]  # a short horizontal lesson stays
    hidden = {h["video_id"]: h for h in body["hidden"]}
    assert body["hidden_count"] == 5
    assert hidden["musicvid001"]["reasons"] == ["YouTube lists this as Music"] and hidden["musicvid001"]["playable"]
    assert hidden["agerestrict"]["reasons"] == ["Age-restricted by YouTube"] and not hidden["agerestrict"]["playable"]
    assert not hidden["noembed0001"]["playable"]
    assert not hidden["blockedIN01"]["playable"]
    assert hidden["shortvid001"]["playable"]
    assert body["mode"] == "live" and body["searches_left"] == get_settings().search_quota_per_day - 1


def test_same_search_twice_uses_one_quota_call(yt, signed_in):
    signed_in.post("/api/search", json={"q": "cost accounting"})
    r = signed_in.post("/api/search", json={"q": "  Cost   ACCOUNTING "})
    assert r.json()["mode"] == "cache"
    assert len(yt.search_calls) == 1
    assert len(yt.video_calls) == 1  # details reused too


def test_safe_search_is_always_strict():
    import httpx
    import respx

    from app.youtube import YouTubeClient

    with respx.mock(assert_all_called=True) as mock:
        route = mock.get("https://www.googleapis.com/youtube/v3/search").respond(200, json={"items": []})
        YouTubeClient("k", httpx.Client()).search("anything", "en")
        assert route.calls.last.request.url.params["safeSearch"] == "strict"
        assert route.calls.last.request.url.params["type"] == "video"


def test_quota_guard_serves_saved_results(yt, signed_in, db, monkeypatch):
    # The user hides music and news themselves (they show by default since plan v3).
    signed_in.post("/api/me/settings", json={"hidden_groups": ["music", "news", "gaming", "comedy", "entertainment"]})
    signed_in.post("/api/search", json={"q": "cost accounting"})
    # Make the saved search a day old (stale but under 30 days) and use up the day's quota.
    row = db.scalar(select(YtSearchCache))
    row.fetched_at = datetime.now(timezone.utc) - timedelta(days=2)
    db.commit()
    monkeypatch.setattr(get_settings(), "search_quota_per_day", 1)
    r = signed_in.post("/api/search", json={"q": "cost accounting"}).json()
    assert r["mode"] == "cache_stale" and r["searches_left"] == 0
    assert "limit is used up" in r["note"]
    assert [v["video_id"] for v in r["results"]] == ["lecture0001", "shortlesson"]
    assert len(yt.search_calls) == 1


def test_quota_guard_with_nothing_saved_still_answers(yt, signed_in, monkeypatch):
    monkeypatch.setattr(get_settings(), "search_quota_per_day", 0)
    r = signed_in.post("/api/search", json={"q": "brand new topic"})
    assert r.status_code == 200
    assert r.json()["mode"] == "quota_exhausted" and r.json()["results"] == []
    assert yt.search_calls == []


def test_youtube_data_older_than_30_days_is_never_shown(yt, signed_in, db):
    signed_in.post("/api/search", json={"q": "cost accounting"})
    old = datetime.now(timezone.utc) - timedelta(days=31)
    for v in db.scalars(select(YtVideo)):
        v.fetched_at = old
    db.scalar(select(YtSearchCache)).fetched_at = old
    db.commit()
    yt.quota_exceeded = True  # can't refresh, so nothing old may be shown
    r = signed_in.post("/api/search", json={"q": "cost accounting"}).json()
    assert r["results"] == [] and r["mode"] == "quota_exhausted"


def test_search_text_and_video_ids_never_reach_the_log(yt, signed_in, db):
    signed_in.post("/api/search", json={"q": "cost accounting"})
    for row in db.scalars(select(AppLog)):
        text = f"{row.route} {row.action}"
        assert "cost" not in text and "lecture0001" not in text


def test_mutes_and_follows_change_results(yt, signed_in):
    # The user hides music and news themselves (they show by default since plan v3).
    signed_in.post("/api/me/settings", json={"hidden_groups": ["music", "news", "gaming", "comedy", "entertainment"]})
    assert signed_in.post("/api/mutes", json={"kind": "channel", "value": TEACHER}).status_code == 201
    r = signed_in.post("/api/search", json={"q": "cost accounting"}).json()
    assert "lecture0001" in {h["video_id"] for h in r["hidden"]}
    assert signed_in.post("/api/mutes/remove", json={"kind": "channel", "value": TEACHER}).status_code == 204

    # Following the singer's channel means YouTube's "Music" label no longer hides it (the user's own choice).
    assert signed_in.post("/api/follows", json={"channel_id": SINGER}).status_code == 201
    r = signed_in.post("/api/search", json={"q": "cost accounting"}).json()
    assert "musicvid001" in {v["video_id"] for v in r["results"]}
    assert signed_in.get("/api/follows").json() == [SINGER]


def test_bad_channel_ids_are_refused(signed_in):
    assert signed_in.post("/api/follows", json={"channel_id": "not-a-channel"}).status_code == 422
    assert signed_in.post("/api/mutes", json={"kind": "channel", "value": "nope nope"}).status_code == 422


def test_search_needs_an_account(client):
    assert client.post("/api/search", json={"q": "x"}).status_code == 401


def test_http_client_logs_never_carry_the_api_key():
    import logging

    import app.main  # noqa: F401  (sets the levels)

    assert logging.getLogger("httpx").getEffectiveLevel() >= logging.WARNING
    assert logging.getLogger("httpcore").getEffectiveLevel() >= logging.WARNING


def test_search_still_answers_when_youtube_cant_refresh_details(yt, signed_in, db, monkeypatch):
    from app.models import YtVideo
    from app.youtube import YouTubeError

    first = signed_in.post("/api/search", json={"q": "cost accounting"}).json()
    for v in db.scalars(select(YtVideo)):
        v.fetched_at = datetime.now(timezone.utc) - timedelta(days=2)  # stale details, still under 30 days
    db.commit()

    def broken(ids):
        raise YouTubeError("down")

    monkeypatch.setattr(yt, "videos", broken)
    r = signed_in.post("/api/search", json={"q": "cost accounting"})
    assert r.status_code == 200
    assert [v["video_id"] for v in r.json()["results"]] == [v["video_id"] for v in first["results"]]
