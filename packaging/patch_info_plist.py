#!/usr/bin/env python3
"""Patch the PyInstaller-generated Info.plist so macOS can open Markdown files.

Without CFBundleDocumentTypes LaunchServices refuses to hand .md documents to
the app ("cannot open files in the Markdown Text format"), and without an
Apple-event handler the path never reaches the frontend. This script only
touches the bundle metadata; the odoc handler lives in main.py.
"""
import os
import plistlib
import sys

MARKDOWN_UTI = "net.daringfireball.markdown"


def build_document_types():
    return [
        {
            "CFBundleTypeName": "Markdown Text",
            "CFBundleTypeRole": "Editor",
            "LSHandlerRank": "Owner",
            "LSItemContentTypes": [MARKDOWN_UTI, "public.markdown"],
            "CFBundleTypeExtensions": ["md", "markdown", "mdown"],
        },
        {
            "CFBundleTypeName": "Plain Text",
            "CFBundleTypeRole": "Editor",
            "LSHandlerRank": "Alternate",
            "LSItemContentTypes": ["public.plain-text"],
            "CFBundleTypeExtensions": ["txt", "text"],
        },
    ]


def build_imported_types():
    return [
        {
            "UTTypeIdentifier": MARKDOWN_UTI,
            "UTTypeDescription": "Markdown Text",
            "UTTypeConformsTo": ["public.plain-text"],
            "UTTypeTagSpecification": {
                "public.filename-extension": ["md", "markdown", "mdown"],
                "public.mime-type": ["text/markdown", "text/x-markdown"],
            },
        }
    ]


def main():
    if len(sys.argv) < 2:
        print("usage: patch_info_plist.py /path/to/App.app")
        return 2
    app_path = os.path.abspath(sys.argv[1])
    plist_path = os.path.join(app_path, "Contents", "Info.plist")
    if not os.path.isfile(plist_path):
        print("Info.plist not found: " + plist_path)
        return 2

    with open(plist_path, "rb") as fh:
        data = plistlib.load(fh)

    data["CFBundleDocumentTypes"] = build_document_types()
    data["UTImportedTypeDeclarations"] = build_imported_types()
    data["LSSupportsOpeningDocumentsInPlace"] = True

    with open(plist_path, "wb") as fh:
        plistlib.dump(data, fh, sort_keys=False)

    print("Info.plist document types: md/markdown/mdown (Owner), txt (Alternate)")
    return 0


if __name__ == "__main__":
    sys.exit(main())