from __future__ import annotations

import unittest
import weakref
from types import SimpleNamespace

from app.browser.services.diagnostics import BrowserDiagnosticsService
from app.browser.services.tabs import BrowserTabService


class FakePage:
    def __init__(self) -> None:
        self.handlers: dict[str, list] = {}
        self.closed = False

    def on(self, event: str, handler) -> None:
        self.handlers.setdefault(event, []).append(handler)

    def is_closed(self) -> bool:
        return self.closed

    def close_itself(self) -> None:
        self.closed = True
        for handler in self.handlers.get("close", []):
            handler(self)


class ActiveTabCloseTests(unittest.TestCase):
    def _session(self, *pages: FakePage) -> SimpleNamespace:
        return SimpleNamespace(
            page=pages[0],
            context=SimpleNamespace(pages=list(pages)),
            attached_pages=weakref.WeakSet(),
            console_messages=[],
            page_errors=[],
            request_failures=[],
        )

    def test_session_moves_to_another_tab_when_its_active_tab_closes_itself(self) -> None:
        """A page calling window.close() left session.page on a closed page,
        so every later action failed while other tabs were open."""
        service = BrowserDiagnosticsService(SimpleNamespace(), None, None)  # type: ignore[arg-type]
        opener, popup = FakePage(), FakePage()
        session = self._session(opener, popup)
        for page in (opener, popup):
            service.attach_page_listeners(page, session)
        session.page = popup

        popup.close_itself()

        self.assertIs(session.page, opener)

    def test_closing_a_background_tab_keeps_the_active_one(self) -> None:
        service = BrowserDiagnosticsService(SimpleNamespace(), None, None)  # type: ignore[arg-type]
        active, background = FakePage(), FakePage()
        session = self._session(active, background)
        for page in (active, background):
            service.attach_page_listeners(page, session)

        background.close_itself()

        self.assertIs(session.page, active)

    def test_a_closed_window_lists_no_tabs(self) -> None:
        """Closing the browser window left no pages, and the tab list fell
        back to the closed active page: the session never looked closed."""
        page = FakePage()
        session = self._session(page)
        session.context.pages = []
        page.closed = True

        self.assertEqual(BrowserTabService.pages(None, session), [])  # type: ignore[arg-type]

        page.closed = False
        self.assertEqual(BrowserTabService.pages(None, session), [page])  # type: ignore[arg-type]


if __name__ == "__main__":
    unittest.main()
