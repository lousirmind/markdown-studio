"""
PDF export service for Markdown Studio.

Renders the current WKWebView content through macOS native print pipeline
(NSPrintOperation) with the save-to-file job disposition, producing a real,
paginated PDF that honors the print stylesheet (@media print): chrome is
hidden, Markdown typography, KaTeX formulas, Mermaid diagrams and embedded
images are preserved.

Export options (paper / orientation / margins / header-footer / scaling) are
resolved defensively: unknown or out-of-range values silently fall back to the
historical defaults (A4 portrait, 40pt margins, no header/footer, 100%), so a
malformed preference can never break an export.

This module is UI-host specific and deliberately imports no other project
service; the bridge passes the pywebview window instance in.
"""

import json
import math
import os
from typing import Any, Dict, Optional, Tuple

# Paper sizes in PostScript points, always expressed in portrait orientation.
PAPER_SIZES_PT: Dict[str, Tuple[float, float]] = {
    "a4": (595.0, 842.0),
    "letter": (612.0, 792.0),
    "a5": (420.0, 595.0),
}
DEFAULT_PAPER = "a4"

# A4 in PostScript points (legacy module constants kept for compatibility).
A4_WIDTH_PT = PAPER_SIZES_PT["a4"][0]
A4_HEIGHT_PT = PAPER_SIZES_PT["a4"][1]

ORIENTATION_PORTRAIT = "portrait"
ORIENTATION_LANDSCAPE = "landscape"
DEFAULT_ORIENTATION = ORIENTATION_PORTRAIT
_ORIENTATION_ALIASES = {
    "portrait": ORIENTATION_PORTRAIT,
    "vertical": ORIENTATION_PORTRAIT,
    "纵向": ORIENTATION_PORTRAIT,
    "landscape": ORIENTATION_LANDSCAPE,
    "horizontal": ORIENTATION_LANDSCAPE,
    "横向": ORIENTATION_LANDSCAPE,
}

# Margin presets in points; a raw non-negative number is also accepted.
MARGIN_PRESETS_PT: Dict[str, float] = {
    "none": 0.0,
    "narrow": 20.0,
    "standard": 40.0,
    "wide": 60.0,
}
DEFAULT_MARGIN = "standard"
DEFAULT_MARGIN_PT = MARGIN_PRESETS_PT[DEFAULT_MARGIN]
MAX_CUSTOM_MARGIN_PT = 200.0

# Scaling presets (printInfo.scalingFactor); percentages are accepted too.
SCALE_PRESETS: Tuple[float, ...] = (0.5, 0.75, 1.0, 1.25, 1.5)
DEFAULT_SCALE = 1.0

DEFAULT_OPTIONS: Dict[str, Any] = {
    "paper": DEFAULT_PAPER,
    "orientation": DEFAULT_ORIENTATION,
    "margin": DEFAULT_MARGIN,
    "header_footer": False,
    "scale": DEFAULT_SCALE,
}


def _as_float(value: Any) -> Optional[float]:
    """Best-effort finite float conversion; bools are rejected."""
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        number = float(value)
    elif isinstance(value, str):
        text = value.strip().rstrip("%").strip()
        if not text:
            return None
        try:
            number = float(text)
        except (TypeError, ValueError):
            return None
    else:
        return None
    if not math.isfinite(number):
        return None
    return number


def normalize_paper(value: Any) -> str:
    """Return a known paper key; anything unrecognised falls back to A4."""
    if isinstance(value, str):
        key = value.strip().lower()
        aliases = {
            "a4": "a4",
            "iso a4": "a4",
            "letter": "letter",
            "us letter": "letter",
            "a5": "a5",
            "iso a5": "a5",
        }
        return aliases.get(key, DEFAULT_PAPER)
    return DEFAULT_PAPER


def normalize_orientation(value: Any) -> str:
    """Return 'portrait' or 'landscape'; unknown values fall back to portrait."""
    if isinstance(value, str):
        return _ORIENTATION_ALIASES.get(value.strip().lower(), DEFAULT_ORIENTATION)
    return DEFAULT_ORIENTATION


def normalize_margin(value: Any) -> Tuple[str, float]:
    """Resolve a margin preset or a raw point value.

    Returns (label, points). Negative / non-finite / oversized numbers and
    unknown strings fall back to the standard 40pt margin.
    """
    if isinstance(value, str):
        preset = MARGIN_PRESETS_PT.get(value.strip().lower())
        if preset is not None:
            return value.strip().lower(), preset
    number = _as_float(value)
    if number is not None and 0.0 <= number <= MAX_CUSTOM_MARGIN_PT:
        return "custom", number
    return DEFAULT_MARGIN, DEFAULT_MARGIN_PT


def normalize_scale(value: Any) -> float:
    """Return one of the supported scaling factors, or 1.0 for invalid input."""
    number = _as_float(value)
    if number is None:
        return DEFAULT_SCALE
    # Accept percentage-style values (50 / 75 / 100 / 125 / 150).
    if 1.5 < number <= 300.0:
        number = number / 100.0
    for preset in SCALE_PRESETS:
        if abs(number - preset) <= 0.001:
            return preset
    return DEFAULT_SCALE


def _as_bool(value: Any, default: bool = False) -> bool:
    """Strict boolean coercion: the string 'false' must not become True."""
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)) and value in (0, 1):
        return bool(value)
    if isinstance(value, str):
        token = value.strip().lower()
        if token in ("1", "true", "yes", "on", "开", "开启"):
            return True
        if token in ("0", "false", "no", "off", "关", "关闭", ""):
            return False
    return default


def normalize_options(options: Any = None) -> Dict[str, Any]:
    """Coerce an untrusted options payload into the canonical option model.

    Never raises: every invalid field independently falls back to its default.
    """
    if isinstance(options, str):
        try:
            options = json.loads(options)
        except Exception:
            options = None
    if not isinstance(options, dict):
        options = {}

    margin_label, margin_points = normalize_margin(options.get("margin"))
    return {
        "paper": normalize_paper(options.get("paper")),
        "orientation": normalize_orientation(options.get("orientation")),
        # Presets stay symbolic; a valid custom point value is kept numeric so
        # the resolved margin is not lost when the dict is echoed back.
        "margin": margin_label if margin_label != "custom" else margin_points,
        "header_footer": _as_bool(
            options.get("header_footer", options.get("headerFooter")), False
        ),
        "scale": normalize_scale(options.get("scale")),
    }


def resolve_paper_size(options: Dict[str, Any]) -> Tuple[float, float]:
    """Return the NSPrintInfo paper size in portrait coordinates.

    NSPrintInfo interprets paperSize as a portrait rectangle and applies
    orientation itself, so landscape must be requested through setOrientation_
    while this size stays portrait (verified empirically: setting landscape
    dimensions here would swap them twice).
    """
    paper = normalize_paper(options.get("paper"))
    return PAPER_SIZES_PT[paper]


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
    options: Dict[str, Any],
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
        # Browser-style page headers/footers are opt-in; never print a selection.
        settings.setObject_forKey_(
            bool(options.get("header_footer")), AppKit.NSPrintHeaderAndFooter
        )
        settings.setObject_forKey_(False, AppKit.NSPrintSelectionOnly)

        # Orientation first: NSPrintInfo stores paperSize in portrait
        # coordinates and applies orientation on top (see resolve_paper_size).
        orientation = options.get("orientation")
        print_info.setOrientation_(
            AppKit.NSLandscapeOrientation
            if orientation == ORIENTATION_LANDSCAPE
            else AppKit.NSPortraitOrientation
        )
        print_info.setPaperSize_(
            AppKit.NSMakeSize(float(paper_size[0]), float(paper_size[1]))
        )
        print_info.setTopMargin_(margin)
        print_info.setBottomMargin_(margin)
        print_info.setLeftMargin_(margin)
        print_info.setRightMargin_(margin)

        # 0.5 ... 1.5 scaling factor; WebKit paginates at the scaled layout size.
        print_info.setScalingFactor_(float(options.get("scale") or DEFAULT_SCALE))

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
                "options": dict(options),
                "paper_size": [float(paper_size[0]), float(paper_size[1])],
                "margin_pt": float(margin),
            },
        }
    except Exception as exc:  # pragma: no cover - defensive bridge boundary
        return {"ok": False, "error": "PDF export failed: " + str(exc)}


def export_pdf(
    window,
    target_path: str,
    options: Optional[Dict[str, Any]] = None,
    paper_size: Optional[Tuple[float, float]] = None,
    margin: Optional[float] = None,
) -> Dict[str, Any]:
    """Export the current WebKit view to a paginated PDF file.

    Args:
        window: pywebview Window instance (host of the WKWebView).
        target_path: Absolute output path; .pdf is appended when missing.
        options: Optional dict with keys paper ("a4" | "letter" | "a5"),
            orientation ("portrait" | "landscape"), margin ("none" | "narrow"
            | "standard" | "wide" or a non-negative point value),
            header_footer (bool) and scale (0.5 | 0.75 | 1.0 | 1.25 | 1.5).
            Invalid values fall back to the defaults instead of raising.
        paper_size: Deprecated (width, height) override in portrait points.
        margin: Deprecated margin override in points.

    Returns:
        {"ok": True, "data": {"path", "size", "pages", "options", ...}} or
        {"ok": False, "error": str}
    """
    if not target_path or not str(target_path).strip():
        return {"ok": False, "error": "PDF target path cannot be empty"}

    try:
        normalized = normalize_options(options)
        _, margin_pt = normalize_margin(normalized.get("margin"))
        size = resolve_paper_size(normalized)

        # Legacy overrides: only applied when explicitly supplied and valid.
        if isinstance(paper_size, (tuple, list)) and len(paper_size) == 2:
            width = _as_float(paper_size[0])
            height = _as_float(paper_size[1])
            if width and height and width > 0 and height > 0:
                size = (width, height)
        if margin is not None:
            legacy_margin = _as_float(margin)
            if legacy_margin is not None and 0.0 <= legacy_margin <= MAX_CUSTOM_MARGIN_PT:
                margin_pt = legacy_margin
    except Exception:
        # Normalization is defensive by design; this is the absolute fallback.
        normalized = dict(DEFAULT_OPTIONS)
        size = PAPER_SIZES_PT[DEFAULT_PAPER]
        margin_pt = DEFAULT_MARGIN_PT

    # WKWebView print operations must NOT be invoked on the Cocoa main run-loop
    # thread: doing so either deadlocks or paginates forever. The bridge calls
    # this from a short-lived worker thread instead (verified empirically).
    return _do_export(window, target_path, size, margin_pt, normalized)
