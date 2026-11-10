#!/usr/bin/env python3
"""
End-to-End Automated Integration Test for Markdown Studio.
Launches PyWebView with real frontend/index.html and DesktopBridge,
verifies all core workflows, and exits cleanly.
"""

import os
import sys
import time
import json
import webview

from backend.bridge import DesktopBridge

PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))
FRONTEND_HTML = os.path.join(PROJECT_ROOT, "frontend", "index.html")
WELCOME_MD = os.path.join(PROJECT_ROOT, "sample", "welcome.md")

test_results = {
    "passed": 0,
    "failed": 0,
    "details": [],
}


def log_test(name: str, condition: bool, extra: str = ""):
    status = "✅ PASS" if condition else "❌ FAIL"
    msg = f"[{status}] {name}"
    if extra:
        msg += f" -> {extra}"
    print(msg)
    if condition:
        test_results["passed"] += 1
    else:
        test_results["failed"] += 1
    test_results["details"].append({"name": name, "passed": condition, "extra": extra})


def run_e2e_tests(window):
    print("=" * 65)
    print("🚀 Markdown Studio - Real E2E Automated Integration Tests")
    print("=" * 65)

    try:
        # 1. Wait for frontend bootstrap and bridge handshake
        print("⏳ Waiting for frontend bootstrap (max 8s)...")
        app_ready = False
        for _ in range(40):
            time.sleep(0.2)
            try:
                ready_check = window.evaluate_js(
                    "typeof window.AppStore !== 'undefined' && "
                    "typeof window.EditorEngine !== 'undefined' && "
                    "typeof window.BridgeClient !== 'undefined'"
                )
                if ready_check:
                    app_ready = True
                    break
            except Exception:
                pass

        log_test("Frontend Core Globals Loaded", app_ready, "AppStore, EditorEngine, BridgeClient exist")
        if not app_ready:
            print("❌ Frontend failed to initialize. Aborting.")
            window.destroy()
            return

        # 2. Wait for welcome.md to be opened in active tab
        print("⏳ Waiting for welcome.md to load into active tab...")
        tab_loaded = False
        active_tab_data = {}
        for _ in range(40):
            time.sleep(0.2)
            try:
                tab_json = window.evaluate_js(
                    "JSON.stringify(window.AppStore ? window.AppStore.getActiveTab() : null)"
                )
                if tab_json:
                    data = json.loads(tab_json)
                    if data and data.get("name") == "welcome.md" and len(data.get("content", "")) > 100:
                        tab_loaded = True
                        active_tab_data = data
                        break
            except Exception:
                pass

        log_test(
            "Document Loaded via Bridge",
            tab_loaded,
            f"Tab: {active_tab_data.get('name')}, Size: {len(active_tab_data.get('content', ''))} chars",
        )

        # 3. Verify File Tree rendered
        print("⏳ Verifying Workspace File Tree...")
        file_tree_rendered = False
        file_nodes_count = 0
        for _ in range(30):
            time.sleep(0.2)
            try:
                file_nodes_count = window.evaluate_js(
                    "document.querySelectorAll('#file-tree-container .tree-node').length"
                )
                if file_nodes_count > 0:
                    file_tree_rendered = True
                    break
            except Exception:
                pass

        log_test(
            "File Tree Nodes Rendered",
            file_tree_rendered and file_nodes_count >= 2,
            f"Rendered {file_nodes_count} file/folder nodes in #file-tree-container",
        )

        # 4. Verify Editor Content in IR mode
        editor_content = window.evaluate_js("window.EditorEngine.getValue()") or ""
        log_test(
            "Editor Content Sync",
            "欢迎使用 Markdown Studio" in editor_content,
            f"Content snippet: {editor_content[:40]}...",
        )

        # 5. Verify TOC Outline Tree
        print("⏳ Verifying TOC Outline Tree generation...")
        toc_rendered = False
        toc_items_count = 0
        toc_sample_titles = []
        for _ in range(30):
            time.sleep(0.2)
            try:
                toc_items_count = window.evaluate_js(
                    "document.querySelectorAll('#toc-tree-container .toc-item').length"
                )
                if toc_items_count > 0:
                    toc_rendered = True
                    sample_json = window.evaluate_js(
                        "JSON.stringify(Array.from(document.querySelectorAll('#toc-tree-container .toc-title')).slice(0, 4).map(e => e.textContent.trim()))"
                    )
                    toc_sample_titles = json.loads(sample_json) if sample_json else []
                    break
            except Exception:
                pass

        log_test(
            "TOC Outline Hierarchy Generated",
            toc_rendered and toc_items_count >= 5,
            f"Generated {toc_items_count} heading items. First items: {toc_sample_titles}",
        )

        # 6. Verify Status Bar Metrics
        word_count_text = window.evaluate_js("document.getElementById('status-word-count').textContent") or ""
        char_count_text = window.evaluate_js("document.getElementById('status-char-count').textContent") or ""
        status_path = window.evaluate_js("document.getElementById('status-file-path').textContent") or ""
        log_test(
            "Status Bar Real-time Stats",
            "welcome.md" in status_path and "字" in char_count_text and "词" in word_count_text,
            f"Path: {status_path}, Words: {word_count_text}, Chars: {char_count_text}",
        )

        # 7. Test Switch to Reader Mode & Callouts Enhancement
        print("⏳ Testing Mode Switch: 'reader' (Pure Reading Mode)...")
        window.evaluate_js("window.EditorEngine.setMode('reader')")
        time.sleep(1.2)  # Wait for Vditor.preview and enhancers

        reader_active = window.evaluate_js(
            "document.getElementById('app-root').dataset.mode === 'reader' && "
            "getComputedStyle(document.getElementById('reader-scroll-wrap')).display !== 'none'"
        )
        log_test("Switch to Reader Mode", reader_active, "dataset.mode = 'reader', reader-scroll-wrap visible")

        # Verify Callout Alerts Enhancement in Reader mode
        callout_count = window.evaluate_js(
            "document.querySelectorAll('#reader-container .md-callout').length"
        )
        callout_types = window.evaluate_js(
            "JSON.stringify(Array.from(document.querySelectorAll('#reader-container .md-callout')).map(e => e.className))"
        )
        callout_classes = json.loads(callout_types) if callout_types else []
        log_test(
            "Callout Admonitions Enhanced",
            callout_count >= 4,
            f"Rendered {callout_count} Callouts: {callout_classes}",
        )

        # Verify Local Image Loading (bridge data URL; async resolution -> poll)
        cover_img_src = ""
        cover_img_ok = False
        for _ in range(60):
            time.sleep(0.25)
            img_state = window.evaluate_js(
                "(() => { const img = document.querySelector('#reader-container img');"
                " if (!img) return null;"
                " return JSON.stringify({src: img.src, w: img.naturalWidth, complete: img.complete}); })()"
            )
            if not img_state:
                continue
            state = json.loads(img_state)
            cover_img_src = (state.get("src") or "")[:80]
            if state.get("w", 0) > 0:
                cover_img_ok = True
                break
        log_test(
            "Local Image Loaded (bridge data URL)",
            cover_img_ok and cover_img_src.startswith("data:image/"),
            f"Resolved src: {cover_img_src}... naturalWidth>0: {cover_img_ok}",
        )

        # 8. Test Switch to SV Mode (Split View)
        print("⏳ Testing Mode Switch: 'sv' (Split View Mode)...")
        window.evaluate_js("window.EditorEngine.setMode('sv')")
        time.sleep(1.2)

        sv_active = window.evaluate_js(
            "document.getElementById('app-root').dataset.mode === 'sv' && "
            "document.getElementById('vditor-container').style.display !== 'none'"
        )
        log_test("Switch to SV Mode", sv_active, "dataset.mode = 'sv', vditor-container visible")

        # 9. Test Switch to WYSIWYG Mode
        print("⏳ Testing Mode Switch: 'wysiwyg' (WYSIWYG Mode)...")
        window.evaluate_js("window.EditorEngine.setMode('wysiwyg')")
        time.sleep(1.2)

        wysiwyg_active = window.evaluate_js(
            "document.getElementById('app-root').dataset.mode === 'wysiwyg'"
        )
        log_test("Switch to WYSIWYG Mode", wysiwyg_active, "dataset.mode = 'wysiwyg'")

        # 10. Test Switch back to IR Mode
        print("⏳ Testing Mode Switch: 'ir' (Instant Rendering Mode)...")
        window.evaluate_js("window.EditorEngine.setMode('ir')")
        time.sleep(1.2)

        ir_active = window.evaluate_js(
            "document.getElementById('app-root').dataset.mode === 'ir'"
        )
        log_test("Switch back to IR Mode", ir_active, "dataset.mode = 'ir'")

        # 11. Test Appearance / Preferences Application
        window.evaluate_js("window.AppStore.updatePreference('fontSize', 20)")
        time.sleep(0.3)
        font_size_css = window.evaluate_js(
            "document.documentElement.style.getPropertyValue('--md-font-size')"
        ) or ""
        log_test(
            "Appearance Dynamic CSS Variable",
            font_size_css.strip() == "20px",
            f"--md-font-size: {font_size_css}",
        )

        # 12. Check for uncaught JS errors
        js_errors = window.evaluate_js(
            "window.__test_js_errors || []"
        ) or []
        log_test(
            "Zero Uncaught JavaScript Errors",
            len(js_errors) == 0,
            f"Errors found: {js_errors}",
        )

    except Exception as e:
        print(f"❌ Exception during E2E test execution: {e}")
        import traceback
        traceback.print_exc()
        test_results["failed"] += 1
    finally:
        print("=" * 65)
        total = test_results["passed"] + test_results["failed"]
        pct = (test_results["passed"] / total * 100) if total > 0 else 0
        print(f"📊 E2E Integration Results: {test_results['passed']}/{total} passed ({pct:.1f}%)")
        print("=" * 65)
        window.destroy()


def builtin_window_kwargs(width, height, margin=40):
    """Return create_window kwargs that place the window on the built-in display.

    pywebview's x/y are relative to the selected Screen (top-left, y downward),
    so passing an absolute NSScreen origin makes the window land off-screen and
    Cocoa crashes in windowDidMove_. Select the built-in Screen explicitly.
    """
    try:
        import webview as _wv
        from AppKit import NSScreen
        from Quartz import CGDisplayIsBuiltin
        idx = None
        for i, s in enumerate(NSScreen.screens()):
            did = s.deviceDescription().objectForKey_("NSScreenNumber")
            if did is not None and CGDisplayIsBuiltin(int(did)):
                idx = i
                break
        screens = list(getattr(_wv, "screens", []) or [])
        if idx is not None and idx < len(screens):
            return {"screen": screens[idx], "x": margin, "y": margin}
    except Exception:
        pass
    return {}

def main():
    bridge = DesktopBridge(initial_file=WELCOME_MD)

    win_w, win_h = 1400, 900
    win_kw = builtin_window_kwargs(win_w, win_h)

    window = webview.create_window(
        title="Markdown Studio [E2E Test]",
        url=FRONTEND_HTML,
        js_api=bridge,
        width=win_w,
        height=win_h,
        **win_kw,
        focus=False,
        text_select=True,
    )
    bridge.set_window(window)

    webview.start(run_e2e_tests, window, http_server=True)

    sys.exit(0 if test_results["failed"] == 0 and test_results["passed"] > 0 else 1)


if __name__ == "__main__":
    main()