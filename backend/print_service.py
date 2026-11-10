"""
PDF export service for Markdown Studio.

Renders the current WKWebView content through macOS native print pipeline
(NSPrintOperation) with the save-to-file job disposition, producing a real,
paginated A4 PDF that honors the print stylesheet (@media print): chrome is
hidden, Markdown typography, KaTeX formulas, Mermaid diagrams and embedded
images are preserved.

This module is UI-host specific and deliberately imports no other project
service; the bridge passes the pywebview window instance in.
"""

import os
from typing import Any, Dict, Optional, Tuple

# A4 in PostScript points.
A4_WIDTH_PT = 595.0
A4_HEIGHT_PT = 842.0
DEFAULT_MARGIN_PT = 40.0


def _count_pages(pdf_path: str) -> Optional[int]:
    """Best-effort page count via PDFKit; returns None when unavailable."""
    try:
        from Quartz import PDFDocument  # PDFKit
        from Foundation import NSURL

        doc = PDFDocument.alloc().initWithURL_(NSURL.fileURLWithPath_(pdf_path))
        return int(doc.pageCount()) if doc is not None else None
    except Exception:
        return None


def _do_export(
    window,
    target_path: str,
    paper_size: Tuple[float, float],
    margin: float,
) -> Dict[str, Any]:
    """Main-thread implementation; never called directly from other services."""
    try:
        from webview.platforms import cocoa

        browser_view = cocoa.BrowserView.instances.get(window.uid) if window else None
        wk_webview = getattr(browser_view, "webview", None) if browser_view else None
        if wk_webview is None:
            return {
                "ok": False,
                "error": "Native WebKit view is not available for PDF export",
            }

        import AppKit

        abs_path = os.path.abspath(os.path.expanduser(target_path))
        if not abs_path.lower().endswith(".pdf"):
            abs_path += ".pdf"
        parent_dir = os.path.dirname(abs_path)
        if parent_dir:
            os.makedirs(parent_dir, exist_ok=True)

        print_info = AppKit.NSPrintInfo.sharedPrintInfo().copy()
        print_info.setJobDisposition_(AppKit.NSPrintSaveJob)

        settings = print_info.dictionary()
        settings.setObject_forKey_(
            AppKit.NSURL.fileURLWithPath_(abs_path), AppKit.NSPrintJobSavingURL
        )
        settings.setObject_forKey_(abs_path, AppKit.NSPrintSavePath)
        # No browser-style page headers/footers and never print a selection.
        settings.setObject_forKey_(False, AppKit.NSPrintHeaderAndFooter)
        settings.setObject_forKey_(False, AppKit.NSPrintSelectionOnly)

        print_info.setPaperSize_(AppKit.NSMakeSize(float(paper_size[0]), float(paper_size[1])))
        print_info.setTopMargin_(margin)
        print_info.setBottomMargin_(margin)
        print_info.setLeftMargin_(margin)
        print_info.setRightMargin_(margin)

        operation = wk_webview.printOperationWithPrintInfo_(print_info)
        if operation is None:
            return {"ok": False, "error": "Failed to create the native print operation"}

        operation.setShowsPrintPanel_(False)
        operation.setShowsProgressPanel_(False)

        if not operation.runOperation():
            return {"ok": False, "error": "Native print operation was cancelled or failed"}

        if not os.path.isfile(abs_path) or os.path.getsize(abs_path) == 0:
            return {"ok": False, "error": "PDF file was not written: " + abs_path}

        return {
            "ok": True,
            "data": {
                "path": abs_path,
                "size": os.path.getsize(abs_path),
                "pages": _count_pages(abs_path),
            },
        }
    except Exception as exc:  # pragma: no cover - defensive bridge boundary
        return {"ok": False, "error": "PDF export failed: " + str(exc)}


def export_pdf(
    window,
    target_path: str,
    paper_size: Optional[Tuple[float, float]] = None,
    margin: float = DEFAULT_MARGIN_PT,
) -> Dict[str, Any]:
    """Export the current WebKit view to a paginated PDF file.

    Args:
        window: pywebview Window instance (host of the WKWebView).
        target_path: Absolute output path; .pdf is appended when missing.
        paper_size: Optional (width, height) in points; defaults to A4.
        margin: Page margin in points.

    Returns:
        {"ok": True, "data": {"path", "size", "pages"}} or
        {"ok": False, "error": str}
    """
    if not target_path or not str(target_path).strip():
        return {"ok": False, "error": "PDF target path cannot be empty"}
    size = paper_size or (A4_WIDTH_PT, A4_HEIGHT_PT)

    # WKWebView print operations must NOT be invoked on the Cocoa main run-loop
    # thread: doing so either deadlocks or paginates forever. The bridge calls
    # this from a short-lived worker thread instead (verified empirically).
    return _do_export(window, target_path, size, margin)
