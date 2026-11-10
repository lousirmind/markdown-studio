#!/usr/bin/env python3
"""
Markdown Studio - 独立阅读与编辑器
Main entry point for the desktop application.
Initializes PyWebView native window and binds the modular Python backend bridge.
"""

import argparse
import os
import sys
import tempfile
import webview

from backend.bridge import DesktopBridge
from backend import config_service, file_service, asset_service


def run_headless_check() -> int:
    """
    Automated self-test verifying all backend service interfaces without launching GUI.
    Returns 0 on success, non-zero on failure.
    """
    print("=" * 60)
    print("🚀 Markdown Studio - Backend Headless Interface Check")
    print("=" * 60)

    passed = 0
    total = 0

    def assert_test(name: str, condition: bool, extra_info: str = ""):
        nonlocal passed, total
        total += 1
        status = "✅ PASS" if condition else "❌ FAIL"
        msg = f"[{status}] Test {total:02d}: {name}"
        if extra_info:
            msg += f" ({extra_info})"
        print(msg)
        if condition:
            passed += 1
        else:
            print(f"       -> Details: {extra_info}")

    # 1. Config Service Check
    res_load = config_service.load_preferences()
    assert_test(
        "config_service.load_preferences",
        res_load.get("ok") is True and "fontSize" in res_load.get("data", {}),
        f"Keys count: {len(res_load.get('data', {}))}",
    )

    test_prefs = res_load.get("data", {}).copy()
    test_prefs["fontSize"] = 18
    res_save = config_service.save_preferences(test_prefs)
    assert_test(
        "config_service.save_preferences",
        res_save.get("ok") is True and res_save.get("data", {}).get("fontSize") == 18,
    )

    # 2. File Service Check
    with tempfile.TemporaryDirectory() as tmp_dir:
        test_file = os.path.join(tmp_dir, "test_doc.md")
        test_content = "# Hello Markdown Studio\n\n- [x] Test item\n"

        # Write
        res_write = file_service.write_file(test_file, test_content)
        assert_test(
            "file_service.write_file",
            res_write.get("ok") is True and os.path.isfile(test_file),
            f"Wrote size: {res_write.get('data', {}).get('size')} bytes",
        )

        # Read
        res_read = file_service.read_file(test_file)
        assert_test(
            "file_service.read_file",
            res_read.get("ok") is True and res_read.get("data", {}).get("content") == test_content,
        )

        # List dir
        res_list = file_service.list_dir(tmp_dir)
        tree = res_list.get("data", {}).get("tree", [])
        assert_test(
            "file_service.list_dir",
            res_list.get("ok") is True and len(tree) >= 1,
            f"Found {len(tree)} entries",
        )

        # Create item
        res_create = file_service.create_item(tmp_dir, "sub_note")
        assert_test(
            "file_service.create_item (auto .md extension)",
            res_create.get("ok") is True and res_create.get("data", {}).get("path", "").endswith(".md"),
            res_create.get("data", {}).get("path", ""),
        )

        # Rename item
        new_path = res_create.get("data", {}).get("path")
        res_rename = file_service.rename_item(new_path, "renamed_note.md")
        assert_test(
            "file_service.rename_item",
            res_rename.get("ok") is True and os.path.basename(res_rename.get("data", {}).get("path", "")) == "renamed_note.md",
        )

        # Mtime check
        res_mtime = file_service.check_files_mtime([test_file])
        assert_test(
            "file_service.check_files_mtime",
            res_mtime.get("ok") is True and res_mtime.get("data", {}).get(test_file) is not None,
        )

        # Delete item
        renamed_target = res_rename.get("data", {}).get("path")
        res_del = file_service.delete_item(renamed_target)
        assert_test(
            "file_service.delete_item",
            res_del.get("ok") is True and not os.path.exists(renamed_target),
        )

    # 3. Asset Service Check
    dummy_b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
    res_img = asset_service.save_clipboard_image(
        current_md_path="", filename="test_pixel.png", base64_data=dummy_b64
    )
    assert_test(
        "asset_service.save_clipboard_image",
        res_img.get("ok") is True and os.path.isfile(res_img.get("data", {}).get("abs_path", "")),
        res_img.get("data", {}).get("rel_path", ""),
    )
    # Clean up test pixel
    if res_img.get("ok"):
        try:
            os.remove(res_img["data"]["abs_path"])
        except Exception:
            pass

    # Export standalone HTML
    with tempfile.NamedTemporaryFile(suffix=".html", delete=False) as tmp_html:
        tmp_html_path = tmp_html.name
    res_export = asset_service.export_standalone_html(
        tmp_html_path, "Test Doc", "<h1>Exported Title</h1><p>Test content</p>"
    )
    assert_test(
        "asset_service.export_standalone_html",
        res_export.get("ok") is True and os.path.isfile(tmp_html_path),
    )
    try:
        os.remove(tmp_html_path)
    except Exception:
        pass

    # 4. Bridge Facade Check
    bridge = DesktopBridge()
    init_state = bridge.get_initial_state()
    assert_test(
        "bridge.get_initial_state",
        init_state.get("ok") is True and os.path.isfile(init_state.get("data", {}).get("welcome_path", "")),
        f"Welcome doc: {os.path.basename(init_state.get('data', {}).get('welcome_path', ''))}",
    )

    print("=" * 60)
    print(f"📊 Results: {passed}/{total} tests passed ({(passed/total)*100:.1f}%)")
    print("=" * 60)
    return 0 if passed == total else 1


def main():
    parser = argparse.ArgumentParser(description="Markdown Studio - 独立阅读与编辑器")
    parser.add_argument("file", nargs="?", default=None, help="Optional Markdown file to open")
    parser.add_argument(
        "--headless-check",
        action="store_true",
        help="Run automated backend tests without opening a window",
    )
    args = parser.parse_args()

    if args.headless_check:
        sys.exit(run_headless_check())

    # Resolve target file if specified
    initial_file = None
    if args.file:
        resolved = os.path.abspath(os.path.expanduser(args.file))
        if os.path.exists(resolved):
            initial_file = resolved
        else:
            print(f"[Warning] Specified file '{args.file}' does not exist.")

    # Initialize Desktop Bridge Facade
    bridge = DesktopBridge(initial_file=initial_file)

    # Locate index.html
    base_dir = os.path.dirname(os.path.abspath(__file__))
    frontend_html = os.path.join(base_dir, "frontend", "index.html")

    # If frontend/index.html is not yet created by frontend subagents, create fallback info page
    html_target = frontend_html
    if not os.path.isfile(frontend_html):
        print(f"[Info] Frontend HTML not found at '{frontend_html}'. Waiting for frontend build.")

    window = webview.create_window(
        title="Markdown Studio - 独立阅读与编辑器",
        url=html_target,
        js_api=bridge,
        width=1400,
        height=900,
        min_size=(900, 600),
        text_select=True,
    )
    bridge.set_window(window)

    # Launch desktop application with local HTTP server for assets & wasm
    webview.start(debug=False, http_server=True)


if __name__ == "__main__":
    main()
