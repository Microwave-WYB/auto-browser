from __future__ import annotations

import json
from pathlib import Path

from cryptography.fernet import Fernet

from app.auth_state import AuthStateManager
from app.browser.services.auth_profiles import BrowserAuthProfileService

STATE = {
    "cookies": [
        {"name": "c_user", "value": "1", "domain": ".facebook.com", "path": "/"},
        {"name": "xs", "value": "2", "domain": "www.facebook.com", "path": "/"},
        {"name": "SID", "value": "3", "domain": ".google.com", "path": "/"},
    ],
    "origins": [
        {"origin": "https://www.facebook.com", "localStorage": [{"name": "k", "value": "v"}]},
        {"origin": "https://mail.google.com", "localStorage": []},
    ],
}


def test_sites_are_named_and_counted_never_shown() -> None:
    sites = BrowserAuthProfileService.sites_in(STATE)
    assert sites == [
        {"site": "facebook.com", "cookies": 2, "origins": 1},
        {"site": "google.com", "cookies": 1, "origins": 1},
    ]
    assert "c_user" not in json.dumps(sites)


def test_forgetting_a_site_takes_out_what_it_and_its_subdomains_set() -> None:
    kept, cookies, origins = BrowserAuthProfileService.without_site(STATE, "www.facebook.com")
    assert (cookies, origins) == (2, 1)
    assert [c["domain"] for c in kept["cookies"]] == [".google.com"]
    assert [o["origin"] for o in kept["origins"]] == ["https://mail.google.com"]


def test_a_state_reads_back_as_it_was_written_encrypted(tmp_path: Path) -> None:
    manager = AuthStateManager(encryption_key=Fernet.generate_key().decode(), require_encryption=True, max_age_hours=0)
    info = manager.write_state(STATE, tmp_path / "state.json")
    path = Path(info["path"])
    assert path.name.endswith(".enc")
    assert "c_user" not in path.read_text()
    assert manager.read_state(path) == STATE
