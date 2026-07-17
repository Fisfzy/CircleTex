#!/usr/bin/env python3
"""在干净 Word 文档中逐公式生成 MathType OLE，并回填到目标 DOCX。"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path
from typing import Any


MATHTYPE_CLASS = "Equation.DSMT4"
WD_COLLAPSE_START = 1
WD_DO_NOT_SAVE_CHANGES = 0
WD_FIND_STOP = 0
WD_INLINE_SHAPE_EMBEDDED_OLE_OBJECT = 1


def configure_stdio() -> None:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")


def emit_progress(
    percent: int,
    message: str,
    *,
    stage_id: str,
    stage_label: str,
    current: int,
    total: int,
    unit: str,
) -> None:
    print(
        json.dumps(
            {
                "type": "progress",
                "percent": percent,
                "message": message,
                "stage": {
                    "id": stage_id,
                    "label": stage_label,
                    "state": "running",
                    "current": current,
                    "total": total,
                    "unit": unit,
                },
            },
            ensure_ascii=False,
            separators=(",", ":"),
        ),
        flush=True,
    )


def load_manifest(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8-sig") as handle:
        value = json.load(handle)
    if not isinstance(value, dict) or not isinstance(value.get("formulas"), list):
        raise ValueError("公式清单格式无效")
    formulas = value["formulas"]
    if not formulas:
        raise ValueError("公式清单为空")
    required = ("placeholder", "latex", "kind", "renderTarget")
    placeholders: set[str] = set()
    for index, formula in enumerate(formulas, start=1):
        if not isinstance(formula, dict) or any(
            not isinstance(formula.get(field), str) or not formula[field]
            for field in required
        ):
            raise ValueError(f"第 {index} 个公式缺少必要字段")
        if formula["kind"] not in ("inline", "display"):
            raise ValueError(f"第 {index} 个公式类型无效")
        if formula["renderTarget"] not in ("mathtype", "word-text"):
            raise ValueError(f"第 {index} 个数学片段输出类型无效")
        if formula["renderTarget"] == "word-text" and not isinstance(formula.get("wordText"), str):
            raise ValueError(f"第 {index} 个普通文本数学片段缺少文本")
        if formula["placeholder"] in placeholders:
            raise ValueError(f"第 {index} 个公式占位符重复")
        placeholders.add(formula["placeholder"])
    return value


def find_literal_ranges(document: Any, text: str) -> list[Any]:
    story = document.Content.Duplicate
    occurrence_count = str(story.Text).count(text)
    if occurrence_count == 0:
        return []
    if occurrence_count > 1:
        raise RuntimeError(f"Word 字面量出现多次：{text}")
    search = story.Duplicate
    finder = search.Find
    finder.ClearFormatting()
    finder.Replacement.ClearFormatting()
    found = finder.Execute(
        FindText=text,
        MatchCase=True,
        MatchWholeWord=False,
        MatchWildcards=False,
        MatchSoundsLike=False,
        MatchAllWordForms=False,
        Forward=True,
        Wrap=WD_FIND_STOP,
        Format=False,
        ReplaceWith="",
        Replace=0,
    )
    if not found or str(search.Text) != text:
        raise RuntimeError("Word 字面量计数与 Range 查找结果不一致")
    return [search.Duplicate]


def verify_shape(shape: Any) -> None:
    if int(shape.Type) != WD_INLINE_SHAPE_EMBEDDED_OLE_OBJECT:
        raise RuntimeError("MathType 生成结果不是内嵌 OLE 对象")
    class_type = str(shape.OLEFormat.ClassType)
    prog_id = str(shape.OLEFormat.ProgID)
    if class_type != MATHTYPE_CLASS or prog_id != MATHTYPE_CLASS:
        raise RuntimeError(f"MathType OLE 类型无效：{class_type}/{prog_id}")


def count_mathtype_objects(document: Any) -> int:
    count = 0
    for index in range(1, int(document.InlineShapes.Count) + 1):
        shape = document.InlineShapes(index)
        if int(shape.Type) != WD_INLINE_SHAPE_EMBEDDED_OLE_OBJECT:
            continue
        try:
            if str(shape.OLEFormat.ProgID) == MATHTYPE_CLASS:
                count += 1
        except Exception:
            continue
    return count


def replace_text_once(document: Any, text: str, replacement: str) -> None:
    matches = find_literal_ranges(document, text)
    if len(matches) != 1:
        raise RuntimeError(f"普通文本占位符必须恰好出现一次：{text}")
    matches[0].Text = replacement


def insert_word_text(document: Any, formula: dict[str, Any]) -> None:
    marker = str(formula["placeholder"])
    matches = find_literal_ranges(document, marker)
    if len(matches) != 1:
        raise RuntimeError(f"普通数学文本占位符必须恰好出现一次：{marker}")
    target = matches[0]
    target.Text = str(formula["wordText"])
    style = str(formula.get("wordTextStyle", "regular"))
    target.Font.Bold = style == "bold"
    target.Font.Italic = style == "italic"


def load_payloads(
    formulas: list[dict[str, Any]], factory_report: Path
) -> list[Path]:
    expected_latex = list(
        dict.fromkeys(str(formula["latex"]).strip() for formula in formulas)
    )
    if not factory_report.is_file():
        raise RuntimeError("MathType 单公式工厂未生成证据报告")
    with factory_report.open("r", encoding="utf-8-sig") as handle:
        report = json.load(handle)
    if not isinstance(report, dict):
        raise RuntimeError("MathType 单公式工厂证据报告格式无效")
    if report.get("state") != "PASS" or report.get("status") != "PASS":
        failures = [
            f"{item.get('formula_id')}：{item.get('root_cause') or item.get('state')}"
            for item in report.get("formulas", [])
            if item.get("state") != "PASS"
        ]
        raise RuntimeError("MathType 单公式工厂未全部通过：" + "；".join(failures[:10]))
    results = report.get("formulas")
    if not isinstance(results, list) or [item.get("canonical_latex") for item in results] != expected_latex:
        raise RuntimeError("MathType 工厂报告与去重公式清单不一致")
    payload_by_latex = {
        str(item["canonical_latex"]): Path(str(item.get("payload_docx_path")))
        for item in results
    }
    if any(not payload.is_file() for payload in payload_by_latex.values()):
        raise RuntimeError("MathType 工厂报告引用了不存在的载荷")
    return [payload_by_latex[str(formula["latex"]).strip()] for formula in formulas]


def insert_payload(target_document: Any, payload_document: Any, formula: dict[str, Any]) -> None:
    marker = str(formula["placeholder"])
    matches = find_literal_ranges(target_document, marker)
    if len(matches) != 1:
        raise RuntimeError(f"公式占位符必须恰好出现一次：{marker}")

    if int(payload_document.OMaths.Count) != 0 or int(payload_document.InlineShapes.Count) != 1:
        raise RuntimeError("持久化 MathType 载荷的对象数量或类型无效")
    shape = payload_document.InlineShapes(1)
    verify_shape(shape)
    target = matches[0]
    target.Text = ""
    target.Collapse(WD_COLLAPSE_START)
    target.FormattedText = shape.Range.FormattedText


def assemble_document(
    win32com: Any,
    input_docx: Path,
    output_docx: Path,
    formulas: list[dict[str, Any]],
    payloads: list[Path],
) -> None:
    shutil.copy2(input_docx, output_docx)
    word = None
    target_document = None
    try:
        word = win32com.client.DispatchEx("Word.Application")
        word.Visible = False
        word.DisplayAlerts = 0
        target_document = word.Documents.Open(
            str(output_docx),
            ConfirmConversions=False,
            ReadOnly=False,
            AddToRecentFiles=False,
            Visible=False,
            OpenAndRepair=False,
            NoEncodingDialog=True,
        )
        if int(target_document.OMaths.Count) != 0:
            raise RuntimeError("基础 DOCX 包含禁止的 OMML 公式")
        if count_mathtype_objects(target_document) != 0:
            raise RuntimeError("基础 DOCX 已包含 MathType 对象")
        math_formulas = [formula for formula in formulas if formula["renderTarget"] == "mathtype"]
        text_formulas = [formula for formula in formulas if formula["renderTarget"] == "word-text"]
        if len(math_formulas) != len(payloads):
            raise RuntimeError("MathType 公式与载荷数量不一致")
        for formula in text_formulas:
            insert_word_text(target_document, formula)
            token = formula.get("equationToken")
            if isinstance(token, str) and token:
                replace_text_once(target_document, token, f"({formula['number']})")
        total = len(math_formulas)
        for index, (formula, payload_path) in enumerate(zip(math_formulas, payloads, strict=True), start=1):
            payload_document = None
            try:
                payload_document = word.Documents.Open(
                    str(payload_path),
                    ConfirmConversions=False,
                    ReadOnly=True,
                    AddToRecentFiles=False,
                    Visible=False,
                    OpenAndRepair=False,
                    NoEncodingDialog=True,
                )
                insert_payload(target_document, payload_document, formula)
            finally:
                if payload_document is not None:
                    payload_document.Close(SaveChanges=WD_DO_NOT_SAVE_CHANGES)
            token = formula.get("equationToken")
            if isinstance(token, str) and token:
                replace_text_once(target_document, token, f"({formula['number']})")
            percent = 55 + round(index / total * 13)
            emit_progress(
                percent,
                "正在回填 MathType 可编辑对象",
                stage_id="assemble-formulas",
                stage_label="装配公式",
                current=index,
                total=total,
                unit="个公式位置",
            )

        if int(target_document.OMaths.Count) != 0:
            raise RuntimeError("MathType 回填后检测到 OMML 公式")
        math_type_count = count_mathtype_objects(target_document)
        if math_type_count != total:
            raise RuntimeError(
                f"MathType 对象数与公式数不一致：{math_type_count}/{total}"
            )
        target_document.Save()
    finally:
        if target_document is not None:
            target_document.Close(SaveChanges=WD_DO_NOT_SAVE_CHANGES)
        if word is not None:
            word.Quit(SaveChanges=WD_DO_NOT_SAVE_CHANGES)


def convert(
    input_docx: Path,
    output_docx: Path,
    manifest_path: Path,
    factory_report: Path,
) -> dict[str, int]:
    manifest = load_manifest(manifest_path)
    formulas = manifest["formulas"]
    math_formulas = [formula for formula in formulas if formula["renderTarget"] == "mathtype"]
    output_docx.parent.mkdir(parents=True, exist_ok=True)
    payloads = load_payloads(math_formulas, factory_report) if math_formulas else []
    if len(payloads) != len(math_formulas):
        raise RuntimeError("MathType 载荷数量与公式清单不一致")
    try:
        import pythoncom
        import win32com.client
    except Exception as exc:
        raise RuntimeError(f"无法加载 Word COM 依赖 pywin32：{exc}") from exc
    pythoncom.CoInitialize()
    try:
        assemble_document(win32com, input_docx, output_docx, formulas, payloads)
    finally:
        pythoncom.CoUninitialize()
    return {
        "mathSegmentCount": len(formulas),
        "formulaCount": len(math_formulas),
        "wordTextCount": len(formulas) - len(math_formulas),
        "mathTypeObjectCount": len(math_formulas),
    }


def main() -> int:
    configure_stdio()
    parser = argparse.ArgumentParser(description="逐公式生成并回填 MathType OLE")
    parser.add_argument("--input-docx", type=Path, required=True)
    parser.add_argument("--output-docx", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--factory-report", type=Path, required=True)
    args = parser.parse_args()
    try:
        result = convert(
            args.input_docx.resolve(),
            args.output_docx.resolve(),
            args.manifest.resolve(),
            args.factory_report.resolve(),
        )
    except Exception as exc:
        print(f"MathType 逐公式回填失败：{exc}", file=sys.stderr, flush=True)
        return 1
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
