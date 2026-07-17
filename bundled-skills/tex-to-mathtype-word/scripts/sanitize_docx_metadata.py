#!/usr/bin/env python3
"""清除 DOCX 非可见表格元数据中由 Pandoc 复制的公式占位符。"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
import zipfile
from pathlib import Path
from xml.dom import minidom


WORDPROCESSINGML_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
PLACEHOLDER_RE = re.compile(r"CIRCLETEX(?:MATH|EQNUM)\d{6}")


def configure_stdio() -> None:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")


def sanitize_word_xml(xml_data: bytes) -> tuple[bytes, int]:
    if b"CIRCLETEX" not in xml_data:
        return xml_data, 0
    document = minidom.parseString(xml_data)
    removed = 0
    for caption in document.getElementsByTagNameNS(WORDPROCESSINGML_NS, "tblCaption"):
        value = caption.getAttributeNS(WORDPROCESSINGML_NS, "val")
        if not value:
            continue
        clean_value, count = PLACEHOLDER_RE.subn("", value)
        if count:
            caption.setAttributeNS(WORDPROCESSINGML_NS, "w:val", clean_value)
            removed += count
    if removed == 0:
        return xml_data, 0
    return document.toxml(encoding="UTF-8", standalone=True), removed


def sanitize_docx(path: Path) -> int:
    if not path.is_file():
        raise FileNotFoundError(f"DOCX 不存在：{path}")
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    os.close(descriptor)
    temporary_path = Path(temporary_name)
    removed = 0
    try:
        with zipfile.ZipFile(path, "r") as source, zipfile.ZipFile(
            temporary_path, "w"
        ) as target:
            for info in source.infolist():
                data = source.read(info.filename)
                if info.filename.startswith("word/") and info.filename.endswith(".xml"):
                    data, count = sanitize_word_xml(data)
                    removed += count
                target.writestr(info, data)
        os.replace(temporary_path, path)
    finally:
        temporary_path.unlink(missing_ok=True)
    return removed


def main() -> int:
    configure_stdio()
    parser = argparse.ArgumentParser(description="清除 DOCX 表格元数据公式占位符")
    parser.add_argument("docx", type=Path)
    args = parser.parse_args()
    try:
        removed = sanitize_docx(args.docx.resolve())
    except Exception as exc:
        print(f"DOCX 元数据清理失败：{exc}", file=sys.stderr, flush=True)
        return 1
    print(
        json.dumps(
            {"status": "success", "removedMetadataPlaceholders": removed},
            ensure_ascii=False,
            separators=(",", ":"),
        ),
        flush=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
