"""
Drag & drop service for Markdown Studio.

Parses the DOM drop event payload produced by pywebview and classifies the
dropped entries into documents, folders, images and unsupported items.

Why this module exists:
    WKWebView never exposes a real filesystem path on a JS File object, so the
    frontend cannot open Finder drops by itself. pywebview's native drop
    channel injects "pywebviewFullPath" into every dropped file entry, and
    this module turns that payload into open requests / toast hints.

Dependency-free by design: the module uses only the Python standard library
and imports no other project service, so the classification rules stay
unit-testable without a GUI.
"""

import os
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

# Documents that can be opened as editor tabs.
TEXT_EXTENSIONS = frozenset({".md", ".markdown", ".mdown", ".txt"})

# Raster/vector image types we recognise so we can show the paste hint
# instead of the generic "unsupported file" toast. Dropped images are never
# copied into assets/.
IMAGE_EXTENSIONS = frozenset(
    {
        ".png",
        ".jpg",
        ".jpeg",
        ".gif",
        ".webp",
        ".bmp",
        ".svg",
        ".heic",
        ".heif",
        ".avif",
        ".tif",
        ".tiff",
    }
)

IMAGE_PASTE_HINT = "图片请使用 Cmd+V 粘贴插入"
UNRESOLVED_HINT = "无法获取拖入项目的完整路径，请改用「打开文件」按钮"
IGNORED_FOLDER_HINT = "一次仅将第一个文件夹切换为工作区，其余文件夹已忽略"
UNSUPPORTED_PREFIX = "不支持的文件类型："

MAX_NAMES_IN_TOAST = 3


def _as_text(value: Any) -> str:
    """Coerce an arbitrary payload value to a stripped string."""
    if isinstance(value, str):
        return value.strip()
    return ""


def _basename(path: str) -> str:
    """Basename that tolerates trailing separators on macOS/Windows paths."""
    if not path:
        return ""
    return os.path.basename(path.rstrip("/\\"))


def _extension(name_or_path: str) -> str:
    return os.path.splitext(name_or_path)[1].lower()


def is_text_file(name_or_path: str) -> bool:
    """Whether a name/path has a document extension the editor can open."""
    return _extension(name_or_path) in TEXT_EXTENSIONS


def is_image_file(name_or_path: str) -> bool:
    """Whether a name/path has a recognised image extension."""
    return _extension(name_or_path) in IMAGE_EXTENSIONS


def _pending_entries(
    pending_paths: Optional[Sequence[Sequence[Any]]],
) -> Iterable[Tuple[int, str, str]]:
    """Yield (index, label, path) for the pending pywebview drop queue."""
    if not pending_paths:
        return
    for index, item in enumerate(pending_paths):
        if not isinstance(item, (list, tuple)) or len(item) < 2:
            continue
        label = _as_text(item[0])
        path = _as_text(item[1])
        if path:
            yield index, label, path


def match_pending_index(
    name: str, pending_paths: Optional[Sequence[Sequence[Any]]]
) -> Optional[int]:
    """Find a queued pywebview path for a dropped entry that lost its path.

    pywebview's Cocoa backend labels a dropped directory with the basename of
    its *parent* directory (basename(dirname(path))), so the util layer's
    name match only works for files. Matching by the directory's own basename
    recovers folders; the label match is kept as a secondary fallback.
    """
    if not name:
        return None

    for index, label, path in _pending_entries(pending_paths):
        base = _basename(path)
        if base == name or (label and label == name):
            return index
        if os.path.isdir(path):
            parent = _basename(os.path.dirname(path.rstrip("/\\")))
            if parent and parent == name:
                return index

    return None


def extract_entries(event: Dict[str, Any]) -> List[Dict[str, str]]:
    """Extract {name, path} entries from a pywebview drop event payload."""
    if not isinstance(event, dict):
        return []

    data_transfer = event.get("dataTransfer")
    if not isinstance(data_transfer, dict):
        data_transfer = event.get("data_transfer")

    files: Any = []
    if isinstance(data_transfer, dict):
        files = data_transfer.get("files")
    if not isinstance(files, (list, tuple)):
        return []

    entries: List[Dict[str, str]] = []
    for item in files:
        if isinstance(item, dict):
            path = _as_text(item.get("pywebviewFullPath"))
            name = _as_text(item.get("name")) or _basename(path)
        elif isinstance(item, str):
            path = ""
            name = _as_text(item)
        else:
            continue

        if not name and not path:
            continue

        entries.append({"name": name, "path": path})

    return entries


def _display_name(path_or_name: str) -> str:
    return _basename(path_or_name) or path_or_name


def _format_names(paths: Sequence[str]) -> str:
    names = [_display_name(item) for item in paths if item]
    shown = names[:MAX_NAMES_IN_TOAST]
    text = "、".join(shown)
    if len(names) > MAX_NAMES_IN_TOAST:
        text += f" 等 {len(names)} 个"
    return text


def _append_unique(bucket: List[str], value: str) -> None:
    if value and value not in bucket:
        bucket.append(value)


def process_drop_event(
    event: Dict[str, Any],
    pending_paths: Optional[Sequence[Sequence[Any]]] = None,
) -> Dict[str, Any]:
    """Classify a pywebview drop event into actionable buckets.

    Args:
        event: Drop event dict received by the pywebview DOM handler.
        pending_paths: Snapshot of webview.dom._dnd_state['paths'] used to
            recover paths pywebview failed to inject (notably folders).

    Returns:
        {
            "files": [abs paths to open as tabs],
            "folders": [abs paths, first one becomes the workspace],
            "images": [paths/names, never uploaded],
            "unsupported": [paths/names],
            "unresolved": [names without a recoverable path],
            "workspace": first folder or None,
            "ignored_folders": folders after the first one,
            "toasts": [{"message": str, "type": "info"|"warning"}],
            "consumed": [{"label": str, "path": str}] (pending queue entries),
        }
    """
    pending = list(pending_paths or [])
    consumed_indices: List[int] = []
    resolved_entries: List[Dict[str, str]] = []

    for entry in extract_entries(event):
        resolved = dict(entry)
        if not resolved.get("path"):
            index = match_pending_index(resolved.get("name", ""), pending)
            if index is not None:
                resolved["path"] = _as_text(pending[index][1])
                if index not in consumed_indices:
                    consumed_indices.append(index)
        resolved_entries.append(resolved)

    files: List[str] = []
    folders: List[str] = []
    images: List[str] = []
    unsupported: List[str] = []
    unresolved: List[str] = []

    for entry in resolved_entries:
        path = entry.get("path", "")
        name = entry.get("name", "") or _basename(path) or "未命名项目"

        if path and os.path.isdir(path):
            _append_unique(folders, path)
            continue

        extension = _extension(path) or _extension(name)
        target = path or name

        if extension in TEXT_EXTENSIONS:
            if path:
                _append_unique(files, path)
            else:
                _append_unique(unresolved, name)
        elif extension in IMAGE_EXTENSIONS:
            _append_unique(images, target)
        else:
            _append_unique(unsupported, target)

    toasts: List[Dict[str, str]] = []
    if images:
        toasts.append({"message": IMAGE_PASTE_HINT, "type": "info"})
    if unsupported:
        toasts.append(
            {
                "message": UNSUPPORTED_PREFIX + _format_names(unsupported),
                "type": "warning",
            }
        )
    if unresolved:
        toasts.append({"message": UNRESOLVED_HINT, "type": "warning"})
    if len(folders) > 1:
        toasts.append({"message": IGNORED_FOLDER_HINT, "type": "info"})

    consumed: List[Dict[str, str]] = []
    for index in consumed_indices:
        item = pending[index]
        consumed.append({"label": _as_text(item[0]), "path": _as_text(item[1])})

    return {
        "files": files,
        "folders": folders,
        "images": images,
        "unsupported": unsupported,
        "unresolved": unresolved,
        "workspace": folders[0] if folders else None,
        "ignored_folders": folders[1:],
        "toasts": toasts,
        "consumed": consumed,
    }
