"""
Bridge facade for Markdown Studio.
Acts as a unified JS-Python bridge aggregating config_service, file_service,
asset_service, and pywebview native desktop dialogs.
"""

import os
from typing import Any, Dict, List, Optional
import webview

from . import asset_service
from . import config_service
from . import file_service


class DesktopBridge:
    """
    Thin facade class exposed to the frontend JavaScript via pywebview js_api.
    All methods return JSON-serializable dictionaries conforming to:
    {"ok": True, "data": ...} or {"ok": False, "error": "..."}
    """

    def __init__(self, initial_file: Optional[str] = None):
        self.window = None
        self.initial_file = os.path.abspath(initial_file) if initial_file else None
        self.project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

    def set_window(self, window):
        """Bind the active pywebview window instance."""
        self.window = window

    # -------------------------------------------------------------------------
    # Initial State
    # -------------------------------------------------------------------------
    def get_initial_state(self) -> Dict[str, Any]:
        """
        Provide frontend with initial configuration, workspace, and welcome document paths.
        """
        prefs_res = config_service.load_preferences()
        prefs = prefs_res.get("data", {})

        welcome_path = os.path.join(self.project_root, "sample", "welcome.md")
        workspace_dir = os.path.join(self.project_root, "sample")

        # If user opened an explicit file from CLI, prioritize that
        target_file = self.initial_file if (self.initial_file and os.path.exists(self.initial_file)) else welcome_path
        if target_file and os.path.exists(target_file):
            workspace_dir = os.path.dirname(target_file)

        return {
            "ok": True,
            "data": {
                "preferences": prefs,
                "welcome_path": welcome_path,
                "target_file": target_file,
                "workspace_dir": workspace_dir,
                "project_root": self.project_root,
            },
        }

    # -------------------------------------------------------------------------
    # File Operations
    # -------------------------------------------------------------------------
    def read_file(self, path: str) -> Dict[str, Any]:
        return file_service.read_file(path)

    def write_file(self, path: str, content: str) -> Dict[str, Any]:
        return file_service.write_file(path, content)

    def list_dir(
        self,
        dir_path: str,
        show_hidden: bool = False,
        sort_by: str = "name",
        sort_asc: bool = True,
    ) -> Dict[str, Any]:
        return file_service.list_dir(
            dir_path=dir_path,
            show_hidden=show_hidden,
            sort_by=sort_by,
            sort_asc=sort_asc,
        )

    def create_item(self, parent_dir: str, name: str, is_dir: bool = False) -> Dict[str, Any]:
        return file_service.create_item(parent_dir, name, is_dir=is_dir)

    def rename_item(self, old_path: str, new_name: str) -> Dict[str, Any]:
        return file_service.rename_item(old_path, new_name)

    def delete_item(self, path: str) -> Dict[str, Any]:
        return file_service.delete_item(path)

    def check_files_mtime(self, paths: List[str]) -> Dict[str, Any]:
        return file_service.check_files_mtime(paths)

    def read_file_data_url(self, path: str) -> Dict[str, Any]:
        """
        Read a local image file (png/jpg/jpeg/gif/svg/webp/bmp) as a data URL.
        Used by the frontend to display images located outside the static
        pywebview HTTP root without weakening the web security model.
        """
        return file_service.read_image_data_url(path)

    # -------------------------------------------------------------------------
    # Asset & Export Operations
    # -------------------------------------------------------------------------
    def save_clipboard_image(
        self, current_md_path: str, filename: str, base64_data: str
    ) -> Dict[str, Any]:
        return asset_service.save_clipboard_image(current_md_path, filename, base64_data)

    def export_standalone_html(
        self,
        target_path: str,
        title: str,
        body_html: str,
        theme_css: str = "",
        custom_css: str = "",
    ) -> Dict[str, Any]:
        return asset_service.export_standalone_html(
            target_path, title, body_html, theme_css, custom_css
        )

    # -------------------------------------------------------------------------
    # Configuration
    # -------------------------------------------------------------------------
    def load_preferences(self) -> Dict[str, Any]:
        return config_service.load_preferences()

    def save_preferences(self, prefs: Dict[str, Any]) -> Dict[str, Any]:
        return config_service.save_preferences(prefs)

    # -------------------------------------------------------------------------
    # Native Desktop Dialogs
    # -------------------------------------------------------------------------
    def select_file_dialog(self) -> Dict[str, Any]:
        """Open a native macOS file selection dialog for Markdown documents."""
        if not self.window:
            return {"ok": False, "error": "Native window not attached"}

        try:
            file_types = ("Markdown Files (*.md;*.markdown;*.mdown;*.txt)", "All files (*.*)")
            result = self.window.create_file_dialog(
                webview.OPEN_DIALOG,
                allow_multiple=False,
                file_types=file_types,
            )
            if result and len(result) > 0:
                return {"ok": True, "data": {"path": result[0]}}
            return {"ok": False, "error": "Cancelled by user"}
        except Exception as e:
            return {"ok": False, "error": f"Dialog error: {str(e)}"}

    def select_folder_dialog(self) -> Dict[str, Any]:
        """Open a native macOS folder selection dialog to choose workspace directory."""
        if not self.window:
            return {"ok": False, "error": "Native window not attached"}

        try:
            result = self.window.create_file_dialog(
                webview.FOLDER_DIALOG,
                allow_multiple=False,
            )
            if result and len(result) > 0:
                return {"ok": True, "data": {"path": result[0]}}
            return {"ok": False, "error": "Cancelled by user"}
        except Exception as e:
            return {"ok": False, "error": f"Dialog error: {str(e)}"}

    def export_html_dialog(self, default_name: str, html_content: str) -> Dict[str, Any]:
        """Open a native macOS save dialog to export standalone HTML."""
        if not self.window:
            return {"ok": False, "error": "Native window not attached"}

        try:
            save_name = default_name or "document.html"
            if not save_name.lower().endswith(".html"):
                save_name += ".html"

            file_types = ("HTML Files (*.html)", "All files (*.*)")
            result = self.window.create_file_dialog(
                webview.SAVE_DIALOG,
                save_filename=save_name,
                file_types=file_types,
            )
            if result and len(result) > 0:
                target_path = result[0] if isinstance(result, (list, tuple)) else result
                return asset_service.export_standalone_html(
                    target_path=target_path,
                    title=os.path.splitext(os.path.basename(target_path))[0],
                    body_html=html_content,
                )
            return {"ok": False, "error": "Cancelled by user"}
        except Exception as e:
            return {"ok": False, "error": f"Save dialog error: {str(e)}"}
