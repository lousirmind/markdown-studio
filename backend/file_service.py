"""
File service for Markdown Studio.
Handles local file and directory tree IO operations, file monitoring metadata,
and filesystem manipulations with atomic writes and encoding fallbacks.
This module is fully decoupled and does not import any other project service.
"""

import os
import tempfile
from typing import Any, Dict, List, Optional

EXCLUDED_DIRS = {
    ".git",
    "node_modules",
    "__pycache__",
    ".vscode",
    ".idea",
    ".DS_Store",
    "vendor",
    ".pytest_cache",
}


def read_file(path: str) -> Dict[str, Any]:
    """
    Read file contents with multi-encoding fallback (UTF-8, GBK, GB18030).
    Returns:
        {"ok": True, "data": {"path": abs_path, "name": basename, "content": text, "mtime": float, "size": int}}
        or {"ok": False, "error": str}
    """
    try:
        abs_path = os.path.abspath(os.path.expanduser(path))
        if not os.path.exists(abs_path):
            return {"ok": False, "error": f"File not found: {path}"}
        if not os.path.isfile(abs_path):
            return {"ok": False, "error": f"Path is not a regular file: {path}"}

        stat = os.stat(abs_path)
        with open(abs_path, "rb") as f:
            raw_bytes = f.read()

        # Multi-encoding decode attempt
        text = None
        for enc in ["utf-8", "utf-8-sig", "gbk", "gb18030", "latin-1"]:
            try:
                text = raw_bytes.decode(enc)
                break
            except (UnicodeDecodeError, LookupError):
                continue

        if text is None:
            text = raw_bytes.decode("utf-8", errors="replace")

        return {
            "ok": True,
            "data": {
                "path": abs_path,
                "name": os.path.basename(abs_path),
                "content": text,
                "mtime": stat.st_mtime,
                "size": stat.st_size,
            },
        }
    except Exception as e:
        return {"ok": False, "error": f"Failed to read file '{path}': {str(e)}"}


def write_file(path: str, content: str) -> Dict[str, Any]:
    """
    Atomically write content to file to prevent corruption.
    Returns:
        {"ok": True, "data": {"path": abs_path, "mtime": float, "size": int}}
        or {"ok": False, "error": str}
    """
    try:
        abs_path = os.path.abspath(os.path.expanduser(path))
        parent_dir = os.path.dirname(abs_path)
        os.makedirs(parent_dir, exist_ok=True)

        if not isinstance(content, str):
            content = str(content)

        # Write to temporary file in the same directory, then rename atomically
        fd, temp_path = tempfile.mkstemp(
            dir=parent_dir, prefix=".save_", suffix=".tmp"
        )
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(content)
            f.flush()
            os.fsync(f.fileno())

        os.replace(temp_path, abs_path)
        stat = os.stat(abs_path)

        return {
            "ok": True,
            "data": {
                "path": abs_path,
                "mtime": stat.st_mtime,
                "size": stat.st_size,
            },
        }
    except Exception as e:
        return {"ok": False, "error": f"Failed to write file '{path}': {str(e)}"}


def list_dir(
    dir_path: str,
    show_hidden: bool = False,
    sort_by: str = "name",
    sort_asc: bool = True,
    max_depth: int = 4,
) -> Dict[str, Any]:
    """
    Recursively scan a directory up to max_depth (default 4).
    Filters out heavy directories (.git, node_modules, etc.).
    Directories are always sorted before files, with configurable inner sorting.
    Returns:
        {"ok": True, "data": {"root": abs_path, "tree": list_of_nodes}}
        or {"ok": False, "error": str}
    """
    try:
        abs_root = os.path.abspath(os.path.expanduser(dir_path))
        if not os.path.exists(abs_root):
            return {"ok": False, "error": f"Directory not found: {dir_path}"}
        if not os.path.isdir(abs_root):
            return {"ok": False, "error": f"Path is not a directory: {dir_path}"}

        def _scan(current_path: str, current_depth: int) -> List[Dict[str, Any]]:
            if current_depth > max_depth:
                return []

            nodes = []
            try:
                with os.scandir(current_path) as it:
                    entries = list(it)
            except (PermissionError, OSError):
                return []

            for entry in entries:
                name = entry.name
                if not show_hidden and name.startswith("."):
                    continue
                if name in EXCLUDED_DIRS:
                    continue

                try:
                    is_dir = entry.is_dir(follow_symlinks=False)
                    stat = entry.stat(follow_symlinks=False)
                    node: Dict[str, Any] = {
                        "name": name,
                        "path": entry.path,
                        "is_dir": is_dir,
                        "size": stat.st_size if not is_dir else 0,
                        "mtime": stat.st_mtime,
                    }

                    if is_dir:
                        node["children"] = _scan(entry.path, current_depth + 1)
                    else:
                        node["children"] = None

                    nodes.append(node)
                except (OSError, PermissionError):
                    continue

            # Sort: directories first, then files
            def _sort_key(item: Dict[str, Any]):
                val = item.get(sort_by, "")
                if sort_by == "name":
                    val = str(val).lower()
                return val

            dirs = [n for n in nodes if n["is_dir"]]
            files = [n for n in nodes if not n["is_dir"]]

            dirs.sort(key=_sort_key, reverse=not sort_asc)
            files.sort(key=_sort_key, reverse=not sort_asc)

            return dirs + files

        tree = _scan(abs_root, 1)
        return {
            "ok": True,
            "data": {
                "root": abs_root,
                "tree": tree,
            },
        }
    except Exception as e:
        return {"ok": False, "error": f"Failed to list directory '{dir_path}': {str(e)}"}


def create_item(parent_dir: str, name: str, is_dir: bool = False) -> Dict[str, Any]:
    """
    Create a new file or directory. If file name lacks an extension, automatically appends '.md'.
    Returns: {"ok": True, "data": {"path": new_path}} or {"ok": False, "error": str}
    """
    try:
        abs_parent = os.path.abspath(os.path.expanduser(parent_dir))
        if not os.path.isdir(abs_parent):
            return {"ok": False, "error": f"Parent directory does not exist: {parent_dir}"}

        item_name = name.strip()
        if not item_name:
            return {"ok": False, "error": "Item name cannot be empty"}

        if not is_dir and "." not in item_name:
            item_name += ".md"

        target_path = os.path.join(abs_parent, item_name)
        if os.path.exists(target_path):
            return {"ok": False, "error": f"Item already exists: '{item_name}'"}

        if is_dir:
            os.makedirs(target_path, exist_ok=False)
        else:
            with open(target_path, "w", encoding="utf-8") as f:
                f.write(f"# {os.path.splitext(item_name)[0]}\n\n")

        return {"ok": True, "data": {"path": target_path}}
    except Exception as e:
        return {"ok": False, "error": f"Failed to create item: {str(e)}"}


def rename_item(old_path: str, new_name: str) -> Dict[str, Any]:
    """
    Rename a file or folder.
    Returns: {"ok": True, "data": {"path": new_path}} or {"ok": False, "error": str}
    """
    try:
        abs_old = os.path.abspath(os.path.expanduser(old_path))
        if not os.path.exists(abs_old):
            return {"ok": False, "error": f"Target item not found: {old_path}"}

        parent_dir = os.path.dirname(abs_old)
        clean_name = new_name.strip()
        if not clean_name:
            return {"ok": False, "error": "New name cannot be empty"}

        abs_new = os.path.join(parent_dir, clean_name)
        if os.path.exists(abs_new) and abs_new != abs_old:
            return {"ok": False, "error": f"An item named '{clean_name}' already exists"}

        os.rename(abs_old, abs_new)
        return {"ok": True, "data": {"path": abs_new}}
    except Exception as e:
        return {"ok": False, "error": f"Failed to rename item: {str(e)}"}


def delete_item(path: str) -> Dict[str, Any]:
    """
    Delete a file or empty directory.
    Returns: {"ok": True, "data": {"path": deleted_path}} or {"ok": False, "error": str}
    """
    try:
        abs_path = os.path.abspath(os.path.expanduser(path))
        if not os.path.exists(abs_path):
            return {"ok": False, "error": f"Item not found: {path}"}

        if os.path.isdir(abs_path):
            os.rmdir(abs_path)
        else:
            os.remove(abs_path)

        return {"ok": True, "data": {"path": abs_path}}
    except OSError as oe:
        # If directory is not empty
        return {"ok": False, "error": f"Cannot delete '{os.path.basename(path)}': {oe.strerror or str(oe)}"}
    except Exception as e:
        return {"ok": False, "error": f"Failed to delete item: {str(e)}"}


def check_files_mtime(paths: List[str]) -> Dict[str, Any]:
    """
    Check modification times of a list of file paths.
    Used by frontend polling or auto-refresh to detect external file modifications.
    Returns: {"ok": True, "data": {path: float_mtime_or_null}}
    """
    result: Dict[str, Optional[float]] = {}
    if not isinstance(paths, list):
        return {"ok": True, "data": result}

    for p in paths:
        try:
            abs_p = os.path.abspath(os.path.expanduser(p))
            if os.path.isfile(abs_p):
                result[abs_p] = os.path.getmtime(abs_p)
            else:
                result[abs_p] = None
        except Exception:
            result[p] = None

    return {"ok": True, "data": result}
