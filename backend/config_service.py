"""
Configuration service for Markdown Studio.
Manages user preferences stored in ~/.markdown_studio_prefs.json or project fallback.
This module is fully decoupled and does not import any other project service.
"""

import json
import os
import tempfile
from typing import Any, Dict

DEFAULT_PREFERENCES: Dict[str, Any] = {
    "theme": "auto",
    "codeTheme": "github",
    "fontFamily": "sans",
    "fontSize": 16,
    "maxWidth": "1000px",
    "centered": True,
    "autoSave": True,
    "autoRefresh": True,
    "showHiddenFiles": False,
    "sortBy": "name",
    "sortAsc": True,
    "customCss": "",
}


def get_config_path() -> str:
    """Return the absolute path to the user preferences file."""
    user_home = os.path.expanduser("~")
    primary_path = os.path.join(user_home, ".markdown_studio_prefs.json")
    try:
        # Check if user home is writable
        test_file = os.path.join(user_home, ".markdown_studio_test.tmp")
        with open(test_file, "w") as f:
            f.write("test")
        os.remove(test_file)
        return primary_path
    except Exception:
        # Fallback to project directory
        project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        return os.path.join(project_root, "preferences.json")


def load_preferences() -> Dict[str, Any]:
    """
    Load user preferences from disk.
    Merges saved values with DEFAULT_PREFERENCES to ensure all keys are present.
    Returns: {"ok": True, "data": dict} or {"ok": False, "error": str}
    """
    config_path = get_config_path()
    prefs = DEFAULT_PREFERENCES.copy()

    if os.path.isfile(config_path):
        try:
            with open(config_path, "r", encoding="utf-8") as f:
                saved = json.load(f)
                if isinstance(saved, dict):
                    prefs.update(saved)
            return {"ok": True, "data": prefs}
        except Exception as e:
            return {
                "ok": True,
                "data": prefs,
                "warning": f"Failed to load preferences from {config_path}: {e}. Defaults used.",
            }

    return {"ok": True, "data": prefs}


def save_preferences(new_prefs: Dict[str, Any]) -> Dict[str, Any]:
    """
    Save user preferences to disk safely (atomic write).
    Returns: {"ok": True, "data": dict} or {"ok": False, "error": str}
    """
    if not isinstance(new_prefs, dict):
        return {"ok": False, "error": "Preferences must be a dictionary"}

    config_path = get_config_path()
    parent_dir = os.path.dirname(config_path)

    try:
        os.makedirs(parent_dir, exist_ok=True)
        # Merge with defaults to maintain valid schema
        current = DEFAULT_PREFERENCES.copy()
        current.update(new_prefs)

        # Atomic write via temporary file
        fd, temp_path = tempfile.mkstemp(dir=parent_dir, prefix="prefs_", suffix=".tmp")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(current, f, ensure_ascii=False, indent=2)

        os.replace(temp_path, config_path)
        return {"ok": True, "data": current}
    except Exception as e:
        return {"ok": False, "error": f"Failed to save preferences: {str(e)}"}
