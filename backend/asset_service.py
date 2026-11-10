"""
Asset service for Markdown Studio.
Handles clipboard image decoding and local storage in an 'assets/' folder,
and exports self-contained standalone HTML documents.
This module is fully decoupled and does not import any other project service.
"""

import base64
from datetime import datetime
import os
import re
from typing import Any, Dict
import uuid


def save_clipboard_image(
    current_md_path: str, filename: str, base64_data: str
) -> Dict[str, Any]:
    """
    Decode base64 image data and persist it into the 'assets/' subfolder
    relative to current_md_path (or project sample/assets if not specified).
    Returns:
        {"ok": True, "data": {"rel_path": str, "abs_path": str, "file_url": str}}
        or {"ok": False, "error": str}
    """
    try:
        if not base64_data:
            return {"ok": False, "error": "No image data provided"}

        # Strip Data URL scheme if present (e.g., 'data:image/png;base64,...')
        clean_base64 = base64_data
        img_ext = ".png"
        if "," in base64_data:
            header, clean_base64 = base64_data.split(",", 1)
            # Detect mime type from header
            if "image/jpeg" in header or "image/jpg" in header:
                img_ext = ".jpg"
            elif "image/webp" in header:
                img_ext = ".webp"
            elif "image/gif" in header:
                img_ext = ".gif"
            elif "image/svg" in header:
                img_ext = ".svg"

        image_bytes = base64.b64decode(clean_base64)

        # Determine target directory
        if current_md_path and os.path.exists(os.path.dirname(os.path.abspath(current_md_path))):
            md_dir = os.path.dirname(os.path.abspath(current_md_path))
            assets_dir = os.path.join(md_dir, "assets")
        else:
            # Fallback to sample/assets in project root
            project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
            assets_dir = os.path.join(project_root, "sample", "assets")

        os.makedirs(assets_dir, exist_ok=True)

        # Generate or sanitize filename
        raw_name = (filename or "").strip()
        if not raw_name or raw_name == "image.png":
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            short_id = uuid.uuid4().hex[:6]
            safe_name = f"img_{timestamp}_{short_id}{img_ext}"
        else:
            safe_name = re.sub(r'[^a-zA-Z0-9_\-\.]', '_', raw_name)
            if not any(safe_name.lower().endswith(e) for e in [".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"]):
                safe_name += img_ext

        abs_img_path = os.path.join(assets_dir, safe_name)
        with open(abs_img_path, "wb") as f:
            f.write(image_bytes)

        rel_path = f"./assets/{safe_name}"
        file_url = f"file://{abs_img_path}"

        return {
            "ok": True,
            "data": {
                "rel_path": rel_path,
                "abs_path": abs_img_path,
                "file_url": file_url,
            },
        }
    except Exception as e:
        return {"ok": False, "error": f"Failed to save clipboard image: {str(e)}"}


def export_standalone_html(
    target_path: str,
    title: str,
    body_html: str,
    theme_css: str = "",
    custom_css: str = "",
) -> Dict[str, Any]:
    """
    Assemble and export a completely self-contained HTML document with inline styles,
    KaTeX support, and responsive typography.
    Returns: {"ok": True, "data": {"path": target_path}} or {"ok": False, "error": str}
    """
    try:
        abs_target = os.path.abspath(os.path.expanduser(target_path))
        os.makedirs(os.path.dirname(abs_target), exist_ok=True)

        safe_title = title or "Exported Document"

        # If body_html is already a complete standalone HTML document, write directly
        trimmed = (body_html or "").strip().lower()
        if trimmed.startswith("<!doctype html") or trimmed.startswith("<html"):
            with open(abs_target, "w", encoding="utf-8") as f:
                f.write(body_html)
            return {"ok": True, "data": {"path": abs_target}}

        # Embedded base typography and reset CSS
        base_style = """
:root {
  --color-canvas-default: #ffffff;
  --color-canvas-subtle: #f6f8fa;
  --color-fg-default: #1f2328;
  --color-fg-muted: #656d76;
  --color-border-default: #d0d7de;
  --color-border-muted: hsla(210,18%,87%,1);
  --color-accent-fg: #0969da;
}

@media (prefers-color-scheme: dark) {
  :root {
    --color-canvas-default: #0d1117;
    --color-canvas-subtle: #161b22;
    --color-fg-default: #e6edf3;
    --color-fg-muted: #848d97;
    --color-border-default: #30363d;
    --color-border-muted: #21262d;
    --color-accent-fg: #2f81f7;
  }
}

body {
  margin: 0;
  padding: 0;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  font-size: 16px;
  line-height: 1.6;
  color: var(--color-fg-default);
  background-color: var(--color-canvas-default);
  display: flex;
  justify-content: center;
}

.markdown-container {
  width: 100%;
  max-width: 900px;
  padding: 40px 24px;
  box-sizing: border-box;
}

h1, h2, h3, h4, h5, h6 {
  margin-top: 24px;
  margin-bottom: 16px;
  font-weight: 600;
  line-height: 1.25;
}
h1 { font-size: 2em; border-bottom: 1px solid var(--color-border-muted); padding-bottom: 0.3em; }
h2 { font-size: 1.5em; border-bottom: 1px solid var(--color-border-muted); padding-bottom: 0.3em; }
h3 { font-size: 1.25em; }

p, blockquote, ul, ol, dl, table, pre {
  margin-top: 0;
  margin-bottom: 16px;
}

blockquote {
  padding: 0 1em;
  color: var(--color-fg-muted);
  border-left: 0.25em solid var(--color-border-default);
}

table {
  border-spacing: 0;
  border-collapse: collapse;
  display: block;
  width: max-content;
  max-width: 100%;
  overflow: auto;
}

table th, table td {
  padding: 6px 13px;
  border: 1px solid var(--color-border-default);
}

table tr:nth-child(2n) {
  background-color: var(--color-canvas-subtle);
}

pre {
  padding: 16px;
  overflow: auto;
  font-size: 85%;
  line-height: 1.45;
  background-color: var(--color-canvas-subtle);
  border-radius: 6px;
}

code {
  padding: 0.2em 0.4em;
  margin: 0;
  font-size: 85%;
  background-color: var(--color-canvas-subtle);
  border-radius: 6px;
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
}

pre code {
  padding: 0;
  background-color: transparent;
}

img {
  max-width: 100%;
  box-sizing: content-box;
}

hr {
  height: 0.25em;
  padding: 0;
  margin: 24px 0;
  background-color: var(--color-border-default);
  border: 0;
}
"""

        full_html = f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{safe_title}</title>
  <style>
{base_style}
{theme_css}
{custom_css}
  </style>
</head>
<body>
  <div class="markdown-container vditor-reset">
{body_html}
  </div>
</body>
</html>
"""

        with open(abs_target, "w", encoding="utf-8") as f:
            f.write(full_html)

        return {"ok": True, "data": {"path": abs_target}}
    except Exception as e:
        return {"ok": False, "error": f"Failed to export standalone HTML: {str(e)}"}
