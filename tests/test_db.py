"""Testes da camada de estado SQLite (jobs, meetings, tags)."""

import pytest

from meeting_processor.db import JobsRepo, MeetingsRepo, TagsRepo, init_db


@pytest.fixture
def root(tmp_path):
    init_db(tmp_path)
    return str(tmp_path)


# --- Jobs -----------------------------------------------------------------


def test_job_lifecycle(root):
    jobs = JobsRepo(root)
    jid = jobs.create("reuniao.mp4", "/abs/reuniao.mp4")
    assert isinstance(jid, int)

    jobs.update(jid, status="processing", stage="Transcrevendo", progress=40)
    jobs.update(jid, status="completed", progress=100, detail="ok")

    listed = jobs.list()
    assert len(listed) == 1
    assert listed[0]["status"] == "completed"
    assert listed[0]["progress"] == 100


def test_job_counts(root):
    jobs = JobsRepo(root)
    a = jobs.create("a.mp4")
    b = jobs.create("b.mp4")
    jobs.update(a, status="completed")
    jobs.update(b, status="error", error="boom")
    counts = jobs.counts()
    assert counts.get("completed") == 1
    assert counts.get("error") == 1


def test_job_active_filter(root):
    jobs = JobsRepo(root)
    a = jobs.create("a.mp4")
    jobs.create("b.mp4")  # queued
    jobs.update(a, status="completed")
    active = jobs.active()
    assert len(active) == 1
    assert active[0]["file"] == "b.mp4"


# --- Meetings -------------------------------------------------------------


def test_meeting_upsert_is_idempotent(root):
    repo = MeetingsRepo(root)
    repo.upsert("m1", title="Reuniao 1", created_at="2026-07-01", duration_seconds=600)
    repo.upsert("m1", title="Reuniao 1 (edit)", created_at="2026-07-01", duration_seconds=1200)
    assert repo.count() == 1
    assert repo.list()[0]["duration_seconds"] == 1200


def test_meeting_aggregates(root):
    repo = MeetingsRepo(root)
    repo.upsert("m1", title="A", created_at="2026-07-01", duration_seconds=3600, provider="anthropic")
    repo.upsert("m2", title="B", created_at="2026-07-02", duration_seconds=1800, provider="local")
    assert repo.count() == 2
    assert repo.total_duration_seconds() == 5400
    assert repo.by_provider() == {"anthropic": 1, "local": 1}
    per_day = repo.per_day()
    assert {p["day"] for p in per_day} == {"2026-07-01", "2026-07-02"}


def test_meeting_delete(root):
    repo = MeetingsRepo(root)
    repo.upsert("m1", title="A", created_at="2026-07-01")
    repo.delete("m1")
    assert repo.count() == 0


# --- Tags -----------------------------------------------------------------


def test_tag_add_and_list(root):
    MeetingsRepo(root).upsert("m1", title="A", created_at="2026-07-01")
    tags = TagsRepo(root)
    tags.add_to_meeting("m1", "importante")
    tags.add_to_meeting("m1", "cliente")
    assert set(tags.for_meeting("m1")) == {"importante", "cliente"}


def test_tag_add_is_idempotent(root):
    MeetingsRepo(root).upsert("m1", title="A", created_at="2026-07-01")
    tags = TagsRepo(root)
    tags.add_to_meeting("m1", "x")
    tags.add_to_meeting("m1", "x")
    assert tags.for_meeting("m1") == ["x"]


def test_tag_remove(root):
    MeetingsRepo(root).upsert("m1", title="A", created_at="2026-07-01")
    tags = TagsRepo(root)
    tags.add_to_meeting("m1", "x")
    tags.remove_from_meeting("m1", "x")
    assert tags.for_meeting("m1") == []


def test_tag_counts_and_filter(root):
    m = MeetingsRepo(root)
    m.upsert("m1", title="A", created_at="2026-07-01")
    m.upsert("m2", title="B", created_at="2026-07-02")
    tags = TagsRepo(root)
    tags.add_to_meeting("m1", "vip")
    tags.add_to_meeting("m2", "vip")
    tags.add_to_meeting("m1", "urgente")
    counts = {t["name"]: t["count"] for t in tags.all_with_counts()}
    assert counts == {"vip": 2, "urgente": 1}
    filtered = m.list(tag="urgente")
    assert [x["id"] for x in filtered] == ["m1"]


def test_tag_rename(root):
    m = MeetingsRepo(root)
    m.upsert("m1", title="A", created_at="2026-07-01")
    tags = TagsRepo(root)
    tags.add_to_meeting("m1", "rascunho")
    affected = tags.rename("rascunho", "revisado")
    assert affected == ["m1"]
    assert tags.for_meeting("m1") == ["revisado"]


def test_tag_rename_merges_into_existing(root):
    m = MeetingsRepo(root)
    m.upsert("m1", title="A", created_at="2026-07-01")
    tags = TagsRepo(root)
    tags.add_to_meeting("m1", "a")
    tags.add_to_meeting("m1", "b")
    tags.rename("a", "b")  # 'b' já existe → funde
    assert tags.for_meeting("m1") == ["b"]
    names = {t["name"] for t in tags.all_with_counts()}
    assert names == {"b"}


def test_tag_delete_global(root):
    m = MeetingsRepo(root)
    m.upsert("m1", title="A", created_at="2026-07-01")
    m.upsert("m2", title="B", created_at="2026-07-02")
    tags = TagsRepo(root)
    tags.add_to_meeting("m1", "x")
    tags.add_to_meeting("m2", "x")
    affected = tags.delete_tag("x")
    assert set(affected) == {"m1", "m2"}
    assert tags.all_with_counts() == []


def test_tag_cascade_on_meeting_delete(root):
    m = MeetingsRepo(root)
    m.upsert("m1", title="A", created_at="2026-07-01")
    tags = TagsRepo(root)
    tags.add_to_meeting("m1", "x")
    m.delete("m1")
    # A associação some (cascade); a listagem por tag não retorna nada.
    assert m.list(tag="x") == []
