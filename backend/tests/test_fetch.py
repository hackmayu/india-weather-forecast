"""Fetch helpers with mocked HTTP (SYNTHETIC responses; no network)."""
from datetime import datetime, timezone

from precip import fetch
from precip.fetch import Run


class _Resp:
    def __init__(self, ok=True, headers=None):
        self.ok, self.headers = ok, headers or {}


def test_published_at_parses_last_modified(monkeypatch):
    monkeypatch.setattr(fetch.requests, "head",
                        lambda *a, **k: _Resp(headers={"Last-Modified": "Wed, 04 Nov 2026 07:34:00 GMT"}))
    assert fetch.published_at(Run("20261104", 0)) == datetime(2026, 11, 4, 7, 34, tzinfo=timezone.utc)


def test_published_at_is_none_when_missing_or_failing(monkeypatch):
    monkeypatch.setattr(fetch.requests, "head", lambda *a, **k: _Resp(headers={}))
    assert fetch.published_at(Run("20261104", 0)) is None
    monkeypatch.setattr(fetch.requests, "head", lambda *a, **k: _Resp(ok=False, headers={"Last-Modified": "x"}))
    assert fetch.published_at(Run("20261104", 0)) is None

    def boom(*a, **k):
        raise fetch.requests.ConnectionError("down")
    monkeypatch.setattr(fetch.requests, "head", boom)
    assert fetch.published_at(Run("20261104", 0)) is None


def test_run_horizon_depends_on_issue_hour():
    assert Run("20261104", 0).max_step == 144 and Run("20261104", 12).max_step == 144
    assert Run("20261104", 6).max_step == 90 and Run("20261104", 18).max_step == 90
    assert Run("20261104", 6).steps[:3] == [0, 3, 6]
