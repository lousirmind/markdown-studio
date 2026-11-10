"""
Bridge facade for Markdown Studio.
Acts as a unified JS-Python bridge aggregating config_service, file_service,
asset_service, and pywebview native desktop dialogs.
"""

import json
import os
import sys
import threading
import time
from typing import Any, Dict, List, Optional
import webview

from . import asset_service
from . import config_service
from . import dragdrop_service
from . import file_service
from . import print_service
from . import session_service


class DesktopBridge:
    """
    Thin facade class exposed to the frontend JavaScript via pywebview js_api.
    All methods return JSON-serializable dictionaries conforming to:
    {"ok": True, "data": ...} or {"ok": False, "error": "..."}
    """

    def __init__(self, initial_file: Optional[str] = None):
        self.window = None
        self.initial_file = os.path.abspath(initial_file) if initial_file else None
        if getattr(sys, "frozen", False):
            self.project_root = getattr(
                sys, "_MEIPASS", os.path.dirname(os.path.abspath(sys.executable))
            )
        else:
            self.project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        self._pdf_export_state = None

        # Drag & drop native channel state.
        self._drop_loaded_hook_window = None
        self._drop_handler_registered = False
        self._drop_register_attempts = 0

        # Session persistence state. The last state pushed from JS is cached so
        # the window-closing hook still has something to write when the live
        # synchronous JS read is unavailable.
        self._closing_hook_window = None
        self._closing_save_started = False
        self._last_session_state = None

    def set_window(self, window):
        """Bind the active pywebview window instance.

        Also wires the native Finder drag & drop channel. WKWebView never
        exposes a real path on JS File objects, so the drop entry point must
        live on the Python side: pywebview only collects file paths when a
        drop listener exists, and injects pywebviewFullPath into the event.
        """
        self.window = window
        self._drop_handler_registered = False
        self._drop_register_attempts = 0

        # Session snapshot must be written while the window is still alive.
        self._install_closing_hook(window)

        # The window may already be loaded (e.g. a bridge attached late):
        # loaded is a one-shot event, so register immediately in that case.
        try:
            if window is not None and window.events.loaded.is_set():
                self._install_body_drop_handler()
                return
        except Exception:
            pass

        self._install_drop_loaded_hook()

    # -------------------------------------------------------------------------
    # Session persistence
    # -------------------------------------------------------------------------
    SESSION_STATE_JS = (
        "(() => { try {"
        " if (typeof window.__mdStudioSessionStateJSON !== 'function') return null;"
        " return window.__mdStudioSessionStateJSON();"
        " } catch (e) { return null; } })()"
    )

    def _install_closing_hook(self, window) -> None:
        """Persist the session synchronously right before the window closes.

        pywebview runs the closing event on the Cocoa main thread. Calling
        window.evaluate_js() from there deadlocks (it posts to the main run
        loop and then blocks on a semaphore), so the live state is read through
        a run-loop-pumped WKWebView evaluation (see _read_frontend_session_json).
        Failures never cancel the close.
        """
        if window is None:
            return
        if self._closing_hook_window is window:
            return
        try:
            window.events.closing += self._on_window_closing
            self._closing_hook_window = window
            print("[session] closing hook installed")
        except Exception as e:
            print(f"[session] failed to install closing hook: {e}")

    def _on_window_closing(self, *args) -> None:
        """Closing event handler: save once, never raise, never cancel close."""
        if self._closing_save_started:
            return
        self._closing_save_started = True
        try:
            state = None
            raw = self._read_frontend_session_json()
            if isinstance(raw, str) and raw:
                try:
                    parsed = json.loads(raw)
                except Exception:
                    parsed = None
                if isinstance(parsed, dict):
                    state = parsed
            if state is None and isinstance(self._last_session_state, dict):
                state = self._last_session_state
            if isinstance(state, dict):
                result = session_service.save_session(state)
                print(f"[session] closing save: {result.get('data') or result.get('error')}")
        except Exception as e:
            print(f"[session] closing save failed (ignored): {e}")
        finally:
            # Allow a subsequent close attempt (e.g. a cancelled quit) to save
            # again; the window is gone after a successful close anyway.
            self._closing_save_started = False

    def _read_frontend_session_json(self):
        """Read the live frontend session JSON synchronously.

        On the Cocoa main thread the regular evaluate_js() path would deadlock,
        so the WKWebView is driven directly while a nested run loop processes
        the completion callback (bounded by a short timeout). Off the main
        thread the ordinary bridge call is safe and preferred.
        """
        window = self.window
        if window is None:
            return None

        script = self.SESSION_STATE_JS
        if sys.platform == "darwin" and threading.current_thread() is threading.main_thread():
            return self._evaluate_js_on_main_thread(window, script, timeout=1.5)

        try:
            return window.evaluate_js(script)
        except Exception as e:
            print(f"[session] live state read failed: {e}")
            return None

    @staticmethod
    def _evaluate_js_on_main_thread(window, script: str, timeout: float = 1.5):
        """Synchronously evaluate JS on the Cocoa main thread.

        The completion handler is delivered by the main run loop, so a bounded
        nested run loop is pumped until it fires. Returns None on any failure.
        """
        try:
            import Foundation
            from AppKit import NSDate, NSRunLoop
            from webview.platforms.cocoa import BrowserView
        except Exception:
            return None

        try:
            instance = BrowserView.instances.get(window.uid)
        except Exception:
            instance = None
        webview_view = getattr(instance, "webview", None)
        if webview_view is None:
            return None

        done = [False]
        result = [None]

        def _handler(value, error):
            result[0] = value
            done[0] = True

        try:
            webview_view.evaluateJavaScript_completionHandler_(script, _handler)
        except Exception as e:
            print(f"[session] main-thread JS evaluation failed: {e}")
            return None

        deadline = time.time() + max(0.1, timeout)
        try:
            while not done[0] and time.time() < deadline:
                NSRunLoop.currentRunLoop().runMode_beforeDate_(
                    Foundation.NSDefaultRunLoopMode,
                    NSDate.dateWithTimeIntervalSinceNow_(0.02),
                )
        except Exception:
            return None

        return result[0] if done[0] else None

    def save_session(self, state: Any) -> Dict[str, Any]:
        """Persist a session snapshot sent by the frontend."""
        if self._closing_save_started:
            # A debounced frontend save racing the close must not overwrite the
            # authoritative synchronous snapshot written by the closing hook.
            return {"ok": True, "data": {"skipped": True, "reason": "window-closing"}}
        if isinstance(state, str):
            try:
                state = json.loads(state)
            except Exception as e:
                return {"ok": False, "error": f"Invalid session JSON: {e}"}
        if not isinstance(state, dict):
            return {"ok": False, "error": "Session state must be an object"}

        # Cache the latest state so the closing hook can fall back to it when a
        # live JS read is unavailable.
        self._last_session_state = state
        return session_service.save_session(state)

    def load_session(self) -> Dict[str, Any]:
        """Return the last persisted session snapshot (or data=None)."""
        return session_service.load_session()

    def clear_session(self) -> Dict[str, Any]:
        """Delete the persisted session snapshot."""
        self._last_session_state = None
        return session_service.clear_session()

    # -------------------------------------------------------------------------
    # Native drag & drop (Finder -> window)
    # -------------------------------------------------------------------------
    def _install_drop_loaded_hook(self) -> None:
        """Register a one-time loaded callback that binds the body drop event.

        pywebview cannot register DOM listeners before the page exists, and
        window.dom.body raises until document.body is available. The loaded
        event fires after the pywebview JS object has been injected, which is
        exactly when DOM registration is safe.
        """
        window = self.window
        if window is None:
            return
        if self._drop_loaded_hook_window is window:
            return
        try:
            window.events.loaded += self._on_window_loaded
            self._drop_loaded_hook_window = window
            print("[dragdrop] loaded hook installed")
        except Exception as e:
            print(f"[dragdrop] failed to install loaded hook: {e}")

    def _on_window_loaded(self, *args) -> None:
        """Called by pywebview right after the page finished loading."""
        self._install_body_drop_handler()

    def _install_body_drop_handler(self) -> bool:
        """Bind self.handle_drop_event to document.body's drop event.

        Idempotent per loaded page: the JS flag below is cleared by a reload,
        so a reload correctly re-binds the handler and re-arms the native
        pywebview drop path.
        """
        window = self.window
        if window is None:
            return False

        try:
            already_bound = bool(
                window.evaluate_js("window.__mdStudioDropChannel === true")
            )
        except Exception:
            already_bound = False

        if already_bound:
            self._drop_handler_registered = True
            return True

        try:
            window.dom.body.events.drop += self.handle_drop_event
            window.evaluate_js("window.__mdStudioDropChannel = true; true")
            self._drop_handler_registered = True
            print("[dragdrop] body drop handler registered")
            return True
        except Exception as e:
            self._drop_handler_registered = False
            self._drop_register_attempts += 1
            print(
                f"[dragdrop] body drop registration failed "
                f"(attempt {self._drop_register_attempts}): {e}"
            )
            if self._drop_register_attempts <= 5:
                delay = 0.3 * self._drop_register_attempts
                threading.Timer(delay, self._install_body_drop_handler).start()
            return False

    def _pending_drop_paths(self) -> List[Any]:
        """Snapshot pywebview's native drop queue (private but stable API)."""
        try:
            from webview.dom import _dnd_state

            return list(_dnd_state.get("paths") or [])
        except Exception:
            return []

    def _consume_pending_drop_paths(self, consumed: List[Dict[str, str]]) -> None:
        """Remove queue entries that were resolved manually (folders)."""
        if not consumed:
            return
        try:
            from webview.dom import _dnd_state

            paths = _dnd_state.get("paths")
            if not isinstance(paths, list):
                return
            for item in consumed:
                target = item.get("path")
                for index, entry in enumerate(paths):
                    try:
                        entry_path = entry[1]
                    except (TypeError, IndexError):
                        continue
                    if entry_path == target:
                        paths.pop(index)
                        break
        except Exception:
            pass

    def _emit_frontend_event(self, event_name: str, payload: Dict[str, Any]) -> bool:
        """Emit one AppBus event in the frontend. Returns True on success."""
        window = self.window
        if window is None:
            return False

        # json.dumps handles quotes, backslashes, newlines and non-ASCII paths
        # (Chinese, spaces, emoji) as valid JS literal text.
        payload_js = json.dumps(payload, ensure_ascii=False)
        payload_js = payload_js.replace("\u2028", "\\u2028").replace(
            "\u2029", "\\u2029"
        )
        event_js = json.dumps(event_name)
        script = (
            "(() => { if (!window.AppBus) return false;"
            f" window.AppBus.emit({event_js}, {payload_js});"
            " return true; })()"
        )
        try:
            return bool(window.evaluate_js(script))
        except Exception as e:
            print(f"[dragdrop] emit {event_name} failed: {e}")
            return False

    def handle_drop_event(self, event: Dict[str, Any]) -> Dict[str, Any]:
        """Public drop entry point bound to document.body's drop event.

        pywebview calls this on a background thread with the serialized DOM
        event (including pywebviewFullPath for every file). It never uploads
        or copies dropped content: documents and folders are forwarded to the
        frontend via AppBus, images and unsupported items only raise toasts.

        Returns a JSON-serializable summary so the behaviour is testable
        without a real Finder drag.
        """
        if not isinstance(event, dict):
            return {"ok": False, "error": "Invalid drop event payload"}
        if self.window is None:
            return {"ok": False, "error": "Native window not attached"}

        try:
            parsed = dragdrop_service.process_drop_event(
                event, pending_paths=self._pending_drop_paths()
            )
        except Exception as e:
            return {"ok": False, "error": f"Failed to parse drop event: {e}"}

        self._consume_pending_drop_paths(parsed.get("consumed") or [])

        errors: List[Dict[str, str]] = []
        opened: List[str] = []

        workspace = parsed.get("workspace")
        if workspace:
            if self._emit_frontend_event("folder:open-request", {"path": workspace}):
                opened.append(workspace)
            else:
                errors.append({"path": workspace, "error": "folder:open-request failed"})

        for path in parsed.get("files") or []:
            if self._emit_frontend_event("file:open-request", {"path": path}):
                opened.append(path)
            else:
                errors.append({"path": path, "error": "file:open-request failed"})

        for toast in parsed.get("toasts") or []:
            message = toast.get("message")
            if not message:
                continue
            self._emit_frontend_event(
                "notify:toast",
                {"message": message, "type": toast.get("type") or "info"},
            )

        return {
            "ok": True,
            "data": {
                "files": parsed.get("files") or [],
                "folders": parsed.get("folders") or [],
                "images": parsed.get("images") or [],
                "unsupported": parsed.get("unsupported") or [],
                "unresolved": parsed.get("unresolved") or [],
                "workspace": workspace,
                "ignored_folders": parsed.get("ignored_folders") or [],
                "opened": opened,
                "errors": errors,
            },
        }

    def get_drop_status(self) -> Dict[str, Any]:
        """Expose drag & drop registration state for diagnostics / acceptance."""
        num_listeners = -1
        try:
            from webview.dom import _dnd_state

            num_listeners = int(_dnd_state.get("num_listeners", 0))
        except Exception:
            pass

        js_channel = None
        if self.window is not None:
            try:
                js_channel = bool(
                    self.window.evaluate_js("window.__mdStudioDropChannel === true")
                )
            except Exception:
                js_channel = None

        return {
            "ok": True,
            "data": {
                "registered": bool(self._drop_handler_registered),
                "num_listeners": num_listeners,
                "js_channel": js_channel,
            },
        }

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
                # True when launched with an explicit file argument: the
                # frontend then opens only that file instead of restoring.
                "launched_with_file": bool(self.initial_file),
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

    def export_pdf(
        self, default_name: str = "document.pdf", target_path: Optional[str] = None
    ) -> Dict[str, Any]:
        """Start exporting the current document to a paginated A4 PDF file.

        The print operation itself runs on the Cocoa main thread right after
        this bridge call returns: running NSPrintOperation inside a WebKit
        script-message handler deadlocks or corrupts pagination. The UI polls
        get_pdf_export_result() for the final outcome.
        """
        if not self.window:
            return {"ok": False, "error": "Native window not attached"}

        try:
            save_name = (default_name or "document.pdf").strip() or "document.pdf"
            if not save_name.lower().endswith(".pdf"):
                save_name += ".pdf"

            resolved_path = target_path
            if not resolved_path:
                result = self.window.create_file_dialog(
                    webview.SAVE_DIALOG,
                    save_filename=save_name,
                    file_types=("PDF Files (*.pdf)",),
                )
                if not result:
                    return {"ok": False, "error": "Cancelled by user"}
                resolved_path = result[0] if isinstance(result, (list, tuple)) else result

            abs_path = os.path.abspath(os.path.expanduser(resolved_path))
            if not abs_path.lower().endswith(".pdf"):
                abs_path += ".pdf"

            self._pdf_export_state = {
                "status": "running",
                "path": abs_path,
                "started_at": time.time(),
                "result": None,
            }

            import threading

            def _run_export() -> None:
                outcome = print_service.export_pdf(self.window, abs_path)
                self._pdf_export_state = {
                    "status": "done" if outcome.get("ok") else "error",
                    "path": abs_path,
                    "started_at": time.time(),
                    "result": outcome,
                }

            # Run off the Cocoa main run-loop thread (see print_service notes).
            threading.Thread(target=_run_export, daemon=True).start()
            return {"ok": True, "data": {"path": abs_path, "status": "running"}}
        except Exception as e:
            return {"ok": False, "error": "PDF export dialog error: " + str(e)}

    def get_pdf_export_result(self) -> Dict[str, Any]:
        """Return the state of the most recent PDF export (polled by the UI)."""
        state = self._pdf_export_state
        if not state:
            return {"ok": True, "data": {"status": "idle"}}
        return {"ok": True, "data": state}

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