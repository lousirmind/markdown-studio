"""
Session persistence service for Markdown Studio.

Stores the list of open tabs (plus the workspace directory and editor mode)
so the next launch can restore the previous working session.

Design constraints:
- Standard library only, zero imports from other project modules.
- Default location: ~/.markdown_studio_session.json
- Overridable through the MARKDOWN_STUDIO_SESSION_PATH environment variable
  (used by automated tests; no test path is ever hard-coded here).
- Writes are atomic (temp file in the same directory + os.replace).
- Corrupted / unreadable session files never raise: load_session returns
  {"ok": True, "data": None, "warning": ...} instead.
- Size guard: if the combined tab content exceeds MAX_CONTENT_BYTES, contents
  are dropped (paths / names / dirty flags survive) and truncated=True is
  reported.
"""

import json
import os
import tempfile
import threading
import time
from typing import Any, Dict, List, Optional

SESSION_VERSION = 1
SESSION_PATH_ENV = "MARKDOWN_STUDIO_SESSION_PATH"
DEFAULT_SESSION_PATH = os.path.join(
    os.path.expanduser("~"), ".markdown_studio_session.json"
)
MAX_CONTENT_BYTES = 20 * 1024 * 1024  # 20 MB of tab content
VALID_EDITOR_MODES = ("reader", "ir", "sv", "wysiwyg")

# Serializes concurrent saves (bridge JS calls run on worker threads while the
# window-closing hook runs on the Cocoa main thread).
_WRITE_LOCK = threading.Lock()


def get_session_path() -> str:
    """Return the absolute session file path (env override wins)."""
    override = os.environ.get(SESSION_PATH_ENV)
    if override is not None:
        override = override.strip()
        if override:
            return os.path.abspath(os.path.expanduser(override))
    return DEFAULT_SESSION_PATH


def _coerce_scroll_top(value: Any) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0.0
    if number < 0 or number != number:  # negative or NaN
        return 0.0
    return number


def _normalise_tab(item: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    if not isinstance(item, dict):
        return None

    raw_path = item.get("path")
    path = raw_path if isinstance(raw_path, str) and raw_path else None

    name = item.get("name")
    if not isinstance(name, str) or not name:
        name = os.path.basename(path) if path else "未命名.md"

    tab: Dict[str, Any] = {
        "path": path,
        "name": name,
        "dirty": bool(item.get("dirty")),
        "scrollTop": _coerce_scroll_top(item.get("scrollTop")),
    }

    content = item.get("content")
    if isinstance(content, str):
        tab["content"] = content

    return tab


def _normalise_state(state: Dict[str, Any]) -> Dict[str, Any]:
    """Build a compact, schema-stable session payload."""
    tabs: List[Dict[str, Any]] = []
    raw_tabs = state.get("tabs")
    if isinstance(raw_tabs, list):
        for item in raw_tabs:
            tab = _normalise_tab(item)
            if tab is not None:
                tabs.append(tab)

    version = state.get("version")
    if not isinstance(version, int) or version < 1:
        version = SESSION_VERSION

    workspace_dir = state.get("workspace_dir")
    if not isinstance(workspace_dir, str) or not workspace_dir:
        workspace_dir = None

    active_path = state.get("active_path")
    if not isinstance(active_path, str) or not active_path:
        active_path = None

    active_name = state.get("active_name")
    if not isinstance(active_name, str) or not active_name:
        active_name = None

    editor_mode = state.get("editor_mode")
    if editor_mode not in VALID_EDITOR_MODES:
        editor_mode = "ir"

    return {
        "version": version,
        "saved_at": int(time.time()),
        "workspace_dir": workspace_dir,
        "active_path": active_path,
        "active_name": active_name,
        "editor_mode": editor_mode,
        "tabs": tabs,
    }


def _content_bytes(tabs: List[Dict[str, Any]]) -> int:
    total = 0
    for tab in tabs:
        content = tab.get("content")
        if isinstance(content, str) and content:
            total += len(content.encode("utf-8"))
    return total


def save_session(state: Dict[str, Any]) -> Dict[str, Any]:
    """Persist one session snapshot atomically.

    Returns {"ok": True, "data": {path, tabs, bytes, truncated}} on success or
    {"ok": False, "error": "..."} on failure.
    """
    if not isinstance(state, dict):
        return {"ok": False, "error": "Session state must be a dictionary"}

    path = get_session_path()
    parent_dir = os.path.dirname(path) or "."

    try:
        payload = _normalise_state(state)
        truncated = False
        content_bytes = _content_bytes(payload["tabs"])
        if content_bytes > MAX_CONTENT_BYTES:
            # Oversized session: keep the structure (paths, names, dirty flags)
            # but drop the payloads so the file stays manageable.
            for tab in payload["tabs"]:
                tab.pop("content", None)
            truncated = True
            content_bytes = 0

        raw = json.dumps(payload, ensure_ascii=False)
        encoded = raw.encode("utf-8")

        with _WRITE_LOCK:
            os.makedirs(parent_dir, exist_ok=True)
            fd, temp_path = tempfile.mkstemp(
                dir=parent_dir, prefix="session_", suffix=".tmp"
            )
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as handle:
                    handle.write(raw)
                    handle.flush()
                    try:
                        os.fsync(handle.fileno())
                    except OSError:
                        pass
                os.replace(temp_path, path)
            except Exception:
                try:
                    os.remove(temp_path)
                except OSError:
                    pass
                raise

        return {
            "ok": True,
            "data": {
                "path": path,
                "tabs": len(payload["tabs"]),
                "bytes": len(encoded),
                "content_bytes": content_bytes,
                "truncated": truncated,
            },
        }
    except Exception as exc:
        return {"ok": False, "error": "Failed to save session: " + str(exc)}


def load_session() -> Dict[str, Any]:
    """Load the last session snapshot.

    Returns {"ok": True, "data": dict} when a valid snapshot exists,
    {"ok": True, "data": None} when there is none or it is unusable.
    """
    path = get_session_path()

    if not os.path.isfile(path):
        return {"ok": True, "data": None}

    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except Exception as exc:
        return {
            "ok": True,
            "data": None,
            "warning": "Failed to read session file: " + str(exc),
        }

    if not isinstance(data, dict) or not isinstance(data.get("tabs"), list):
        return {
            "ok": True,
            "data": None,
            "warning": "Session file has an invalid schema",
        }

    return {"ok": True, "data": data, "path": path}


def clear_session() -> Dict[str, Any]:
    """Remove the persisted session file (missing file is not an error)."""
    path = get_session_path()
    try:
        with _WRITE_LOCK:
            if os.path.isfile(path):
                os.remove(path)
        return {"ok": True, "data": {"path": path, "cleared": True}}
    except Exception as exc:
        return {"ok": False, "error": "Failed to clear session: " + str(exc)}
