#!/usr/bin/env python3
"""在干净 Word 文档中编译并验证可复用的单公式 MathType 载荷。"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import platform
import re
import shutil
import sys
import tempfile
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable


PASS = "PASS"
REVIEW = "REVIEW"
FALLBACK = "FALLBACK"
FAIL = "FAIL"
PUBLIC_STATES = frozenset((PASS, REVIEW, FALLBACK, FAIL))

LATEX_UNSUPPORTED_OR_MACRO_NO_OBJECT = "LATEX_UNSUPPORTED_OR_MACRO_NO_OBJECT"
MULTIPLE_OBJECTS_CREATED = "MULTIPLE_OBJECTS_CREATED"
OLE_CONTRACT_INVALID = "OLE_CONTRACT_INVALID"
ROUNDTRIP_MISMATCH = "ROUNDTRIP_MISMATCH"
PERSISTENCE_FAILED = "PERSISTENCE_FAILED"
MATHTYPE_OBJECT_TOO_TALL = "MATHTYPE_OBJECT_TOO_TALL"
MATHTYPE_OBJECT_TOO_WIDE = "MATHTYPE_OBJECT_TOO_WIDE"
MAX_SAFE_HEIGHT_POINTS = 430.0
MAX_SAFE_WIDTH_POINTS = 430.0
ERROR_CODES = frozenset(
    (
        LATEX_UNSUPPORTED_OR_MACRO_NO_OBJECT,
        MULTIPLE_OBJECTS_CREATED,
        OLE_CONTRACT_INVALID,
        ROUNDTRIP_MISMATCH,
        PERSISTENCE_FAILED,
        MATHTYPE_OBJECT_TOO_TALL,
        MATHTYPE_OBJECT_TOO_WIDE,
    )
)

SCHEMA_VERSION = 1
GENERATOR = "compile_mathtype_payloads.py"
WD_FORMAT_DOCUMENT_DEFAULT = 16


def _load_insert_module() -> Any:
    """从同目录加载既有插入器，复用其经过测试的安全函数。"""

    path = Path(__file__).with_name("insert_mathtype_formulas.py")
    spec = importlib.util.spec_from_file_location("pdf2word_insert_mathtype", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"无法加载既有 MathType 插入器：{path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_INSERT = _load_insert_module()
MATHTYPE_CLASS = _INSERT.MATHTYPE_CLASS
MATHTYPE_MACRO = _INSERT.MATHTYPE_MACRO
WD_CONTENT_CONTROL_RICH_TEXT = _INSERT.WD_CONTENT_CONTROL_RICH_TEXT
WD_DO_NOT_SAVE_CHANGES = _INSERT.WD_DO_NOT_SAVE_CHANGES
VALID_FORMULA_ID = _INSERT.VALID_FORMULA_ID


def _load_candidate_module() -> Any:
    path = Path(__file__).with_name("build_mathtype_candidates.py")
    spec = importlib.util.spec_from_file_location("pdf2word_mathtype_candidates", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"无法加载 MathType 候选生成器：{path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_CANDIDATES = _load_candidate_module()


class ChineseArgumentParser(argparse.ArgumentParser):
    """将 argparse 的固定提示改为简体中文。"""

    def format_usage(self) -> str:
        return super().format_usage().replace("usage: ", "用法：", 1)

    def format_help(self) -> str:
        return super().format_help().replace("usage: ", "用法：", 1)

    def error(self, message: str) -> None:
        self.print_usage(sys.stderr)
        self.exit(2, f"{self.prog}：参数错误：{message}\n")


def configure_stdio() -> None:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def bytes_sha256(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def text_sha256(value: str) -> str:
    return bytes_sha256(value.encode("utf-8"))


def file_sha256(path: Path) -> str:
    return _INSERT.file_sha256(path)


def set_state(record: dict[str, Any], state: str) -> None:
    if state not in PUBLIC_STATES:
        raise ValueError(f"无效公开状态：{state}")
    record["state"] = state
    record["status"] = state


def normalize_state(value: Any, default: str = PASS) -> str:
    if value is None:
        return default
    if not isinstance(value, str) or value.strip().upper() not in PUBLIC_STATES:
        raise ValueError(f"无效状态：{value!r}")
    return value.strip().upper()


def _first_nonempty_string(record: dict[str, Any], names: tuple[str, ...]) -> str | None:
    for name in names:
        value = record.get(name)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _validate_declared_hash(value: Any, actual: str, context: str) -> None:
    if value is None:
        return
    if not isinstance(value, str) or value.lower() != actual:
        raise ValueError(f"{context}声明的 SHA-256 与内容不一致")


def _normalize_transform_steps(value: Any, context: str) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list) or any(
        not isinstance(item, str) or not item.strip() for item in value
    ):
        raise ValueError(f"{context}的 transform_steps 必须是非空字符串数组")
    return [item.strip() for item in value]


def normalize_manifest(payload: dict[str, Any]) -> list[dict[str, Any]]:
    """校验候选清单，并为所有可变内容计算不可伪造的哈希。"""

    raw_formulas = payload.get("formulas")
    if not isinstance(raw_formulas, list) or not raw_formulas:
        raise ValueError("候选清单中的 formulas 必须是非空数组")

    formulas: list[dict[str, Any]] = []
    formula_ids: set[str] = set()
    tags: set[str] = set()
    for formula_index, raw_formula in enumerate(raw_formulas, start=1):
        context = f"第 {formula_index} 个公式"
        if not isinstance(raw_formula, dict):
            raise ValueError(f"{context}必须是对象")
        formula_id = raw_formula.get("formula_id")
        if not isinstance(formula_id, str) or not VALID_FORMULA_ID.fullmatch(formula_id):
            raise ValueError(f"{context}的 formula_id 无效")
        if formula_id in formula_ids:
            raise ValueError(f"formula_id 重复：{formula_id}")
        formula_ids.add(formula_id)

        canonical = _first_nonempty_string(
            raw_formula,
            ("canonical_latex", "expected_math_latex", "math_latex", "body_latex"),
        )
        source = raw_formula.get("source")
        if canonical is None and isinstance(source, dict):
            canonical = _first_nonempty_string(source, ("latex", "canonical_latex"))
        if canonical is None:
            raise ValueError(f"公式 {formula_id} 缺少 canonical_latex")
        canonical_hash = text_sha256(canonical)
        _validate_declared_hash(
            raw_formula.get("canonical_latex_hash", raw_formula.get("canonical_hash")),
            canonical_hash,
            f"公式 {formula_id} 的 canonical_latex",
        )
        canonical_semantic_hash = _CANDIDATES.semantic_fingerprint(canonical)
        _validate_declared_hash(
            raw_formula.get("canonical_semantic_hash"),
            canonical_semantic_hash,
            f"公式 {formula_id} 的 canonical 语义指纹",
        )

        tag = raw_formula.get(
            "payload_content_control_tag", raw_formula.get("content_control_tag")
        )
        if tag is None:
            tag = _INSERT.stable_content_control_name(formula_id)
        if (
            not isinstance(tag, str)
            or not tag
            or len(tag) > _INSERT.MAX_CONTENT_CONTROL_NAME
        ):
            raise ValueError(f"公式 {formula_id} 的内容控件 Tag 无效")
        if tag in tags:
            raise ValueError(f"内容控件 Tag 重复：{tag}")
        tags.add(tag)

        raw_candidates = raw_formula.get("candidates")
        if not isinstance(raw_candidates, list) or not raw_candidates:
            raise ValueError(f"公式 {formula_id} 的 candidates 必须是非空数组")
        candidates: list[dict[str, Any]] = []
        candidate_ids: set[str] = set()
        for candidate_index, raw_candidate in enumerate(raw_candidates, start=1):
            candidate_context = f"公式 {formula_id} 的第 {candidate_index} 个候选"
            if not isinstance(raw_candidate, dict):
                raise ValueError(f"{candidate_context}必须是对象")
            candidate_id = raw_candidate.get(
                "candidate_id", f"{formula_id}-candidate-{candidate_index:02d}"
            )
            if (
                not isinstance(candidate_id, str)
                or not VALID_FORMULA_ID.fullmatch(candidate_id)
            ):
                raise ValueError(f"{candidate_context}的 candidate_id 无效")
            if candidate_id in candidate_ids:
                raise ValueError(f"公式 {formula_id} 的 candidate_id 重复：{candidate_id}")
            candidate_ids.add(candidate_id)
            latex = _first_nonempty_string(raw_candidate, ("latex", "math_latex"))
            if latex is None:
                raise ValueError(f"候选 {candidate_id} 缺少 latex")
            latex_hash = text_sha256(latex)
            _validate_declared_hash(
                raw_candidate.get("latex_hash"), latex_hash, f"候选 {candidate_id}"
            )
            candidate_semantic_hash = _CANDIDATES.semantic_fingerprint(latex)
            _validate_declared_hash(
                raw_candidate.get("candidate_semantic_hash"),
                candidate_semantic_hash,
                f"候选 {candidate_id} 的语义指纹",
            )
            _validate_declared_hash(
                raw_candidate.get("canonical_semantic_hash"),
                canonical_semantic_hash,
                f"候选 {candidate_id} 绑定的 canonical 语义指纹",
            )
            if candidate_semantic_hash != canonical_semantic_hash:
                raise ValueError(
                    f"候选 {candidate_id} 的数学 token 与 canonical_latex 不等价"
                )
            if raw_candidate.get("semantic_transform_verified", True) is not True:
                raise ValueError(f"候选 {candidate_id} 未通过兼容转换语义门禁")
            candidates.append(
                {
                    "candidate_id": candidate_id,
                    "latex": latex,
                    "latex_hash": latex_hash,
                    "canonical_semantic_hash": canonical_semantic_hash,
                    "candidate_semantic_hash": candidate_semantic_hash,
                    "semantic_transform_verified": True,
                    "transform_steps": _normalize_transform_steps(
                        raw_candidate.get("transform_steps"), candidate_context
                    ),
                    "source_state": normalize_state(
                        raw_candidate.get("state", raw_candidate.get("status")), PASS
                    ),
                }
            )

        fallback_allowed = raw_formula.get("fallback_allowed", True)
        if not isinstance(fallback_allowed, bool):
            raise ValueError(f"公式 {formula_id} 的 fallback_allowed 必须是布尔值")
        review_reasons = raw_formula.get("review_reasons", [])
        if not isinstance(review_reasons, list) or any(
            not isinstance(item, str) or not item.strip() for item in review_reasons
        ):
            raise ValueError(f"公式 {formula_id} 的 review_reasons 必须是字符串数组")
        formulas.append(
            {
                "formula_id": formula_id,
                "canonical_latex": canonical,
                "canonical_latex_hash": canonical_hash,
                "canonical_semantic_hash": canonical_semantic_hash,
                "content_control_tag": tag,
                "source_state": normalize_state(
                    raw_formula.get("state", raw_formula.get("status")), PASS
                ),
                "review_reasons": [item.strip() for item in review_reasons],
                "fallback_allowed": fallback_allowed,
                "candidates": candidates,
            }
        )
    return formulas


def safe_filename(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value)
    normalized = re.sub(r"[^A-Za-z0-9._-]+", "_", normalized).strip("._-")
    return normalized or "formula"


def error_result(code: str, message: str, **evidence: Any) -> dict[str, Any]:
    if code not in ERROR_CODES:
        raise ValueError(f"未知错误根因代码：{code}")
    result: dict[str, Any] = {
        "state": FAIL,
        "status": FAIL,
        "error_code": code,
        "error": message,
    }
    result.update(evidence)
    return result


def _success_gate_record(raw: Any, *, defaults: dict[str, Any]) -> dict[str, Any]:
    record = dict(raw) if isinstance(raw, dict) else {}
    for key, value in defaults.items():
        record.setdefault(key, value)
    set_state(record, PASS)
    return record


def classify_compiler_result(
    raw: Any, request: dict[str, Any] | None = None
) -> dict[str, Any]:
    """忽略后端自报成功，仅根据可复算门禁判定候选结果。"""

    if not isinstance(raw, dict):
        return error_result(PERSISTENCE_FAILED, "MathType 编译后端未返回对象")
    explicit_code = raw.get("error_code")
    if explicit_code is not None:
        if explicit_code not in ERROR_CODES:
            return error_result(PERSISTENCE_FAILED, "编译后端返回未知错误根因代码")
        return error_result(
            explicit_code,
            str(raw.get("error") or "MathType 候选编译失败"),
            diagnostics=raw.get("diagnostics", []),
            object=raw.get("object"),
            persistence=raw.get("persistence"),
            content=raw.get("content"),
        )

    object_record = raw.get("object")
    object_record = dict(object_record) if isinstance(object_record, dict) else {}
    count = raw.get(
        "created_object_count",
        object_record.get("ole_count", object_record.get("inline_shape_count")),
    )
    if count == 0:
        return error_result(
            LATEX_UNSUPPORTED_OR_MACRO_NO_OBJECT,
            "MathType 宏未生成内嵌对象",
            object=object_record,
        )
    if isinstance(count, int) and count > 1:
        return error_result(
            MULTIPLE_OBJECTS_CREATED,
            f"MathType 宏生成了 {count} 个对象，要求恰好一个",
            object=object_record,
        )
    object_valid = bool(
        count == 1
        and object_record.get("prog_id") == MATHTYPE_CLASS
        and object_record.get("embedded") is True
    )
    if not object_valid:
        return error_result(
            OLE_CONTRACT_INVALID,
            "生成对象不满足 Equation.DSMT4 内嵌 OLE 合同",
            object=object_record,
        )

    persistence = raw.get("persistence")
    persistence = dict(persistence) if isinstance(persistence, dict) else {}
    payload_control_count = raw.get(
        "payload_content_control_count", persistence.get("content_control_count")
    )
    if not (
        persistence.get("reopen_stable") is True
        and persistence.get("content_control_count") == 1
        and persistence.get("inline_shape_count") == 1
        and payload_control_count == 1
    ):
        return error_result(
            PERSISTENCE_FAILED,
            "保存重开后对象或唯一内容控件未稳定保留",
            object=object_record,
            persistence=persistence,
        )

    content = raw.get("content")
    content = dict(content) if isinstance(content, dict) else {}
    roundtrip_tex = content.get("roundtrip_tex")
    if request is not None and isinstance(roundtrip_tex, str):
        roundtrip_semantic_hash = _CANDIDATES.semantic_fingerprint(roundtrip_tex)
        canonical_semantic_hash = request["canonical_semantic_hash"]
        candidate_semantic_hash = request["candidate_semantic_hash"]
        content.update(
            {
                "roundtrip_semantic_hash": roundtrip_semantic_hash,
                "canonical_semantic_hash": canonical_semantic_hash,
                "candidate_semantic_hash": candidate_semantic_hash,
                "candidate_roundtrip_equivalent": (
                    roundtrip_semantic_hash == candidate_semantic_hash
                ),
                "canonical_semantic_equivalent": (
                    roundtrip_semantic_hash == canonical_semantic_hash
                ),
                "semantic_equivalent": (
                    roundtrip_semantic_hash == canonical_semantic_hash
                ),
            }
        )
    if (
        content.get("semantic_equivalent") is not True
        or content.get("canonical_semantic_equivalent", True) is not True
        or not isinstance(roundtrip_tex, str)
    ):
        return error_result(
            ROUNDTRIP_MISMATCH,
            "MathType 回译结果与 canonical_latex 不等价",
            object=object_record,
            persistence=persistence,
            content=content,
        )

    payload_source = raw.get("payload_source_path")
    if not isinstance(payload_source, (str, os.PathLike)):
        return error_result(
            PERSISTENCE_FAILED,
            "编译后端未返回可发布的 payload_source_path",
            object=object_record,
            persistence=persistence,
            content=content,
        )
    payload_source_path = Path(payload_source)
    if not payload_source_path.is_file() or payload_source_path.stat().st_size == 0:
        return error_result(
            PERSISTENCE_FAILED,
            "编译后端返回的单公式 DOCX 不存在或为空",
            object=object_record,
            persistence=persistence,
            content=content,
        )

    object_record = _success_gate_record(
        object_record,
        defaults={"inline_shape_count": 1, "ole_count": 1},
    )
    persistence = _success_gate_record(persistence, defaults={})
    content = _success_gate_record(content, defaults={})
    return {
        "state": PASS,
        "status": PASS,
        "error_code": None,
        "error": None,
        "object": object_record,
        "persistence": persistence,
        "content": content,
        "payload_content_control_count": 1,
        "payload_source_path": str(payload_source_path),
        "diagnostics": raw.get("diagnostics", []),
    }


def _content_controls_by_tag(document: Any, tag: str) -> list[Any]:
    return _INSERT.content_controls_by_tag(document, tag)


def _open_docx(word: Any, path: Path, *, read_only: bool) -> Any:
    return word.Documents.Open(
        str(path),
        ConfirmConversions=False,
        ReadOnly=read_only,
        AddToRecentFiles=False,
        Visible=False,
        OpenAndRepair=False,
        NoEncodingDialog=True,
    )


def seed_formula_selection(document: Any, latex: str) -> tuple[Any, dict[str, Any]]:
    """写入公式后重新取得全文 Range，禁止复用写入前的折叠 Range。"""

    body = re.sub(r"\s+", " ", _INSERT.strip_math_delimiters(latex)).strip()
    seeded_text = rf"\[{body}\]"
    document.Content.Text = seeded_text
    target = document.Content.Duplicate
    observed = str(target.Text)
    while observed.endswith(("\r", "\x07")) and int(target.End) > int(target.Start):
        target.End = int(target.End) - 1
        observed = str(target.Text)
    if observed != seeded_text:
        raise RuntimeError("干净文档中的 MathType 输入选区与候选 LaTeX 不一致")
    target.Select()
    return target, {
        "seeded_text_sha256": text_sha256(seeded_text),
        "selection_text_sha256": text_sha256(observed),
        "selection_start": int(target.Start),
        "selection_end": int(target.End),
        "selection_length": int(target.End) - int(target.Start),
        "selection_verified": True,
    }


def create_mathtype_shape_from_latex(
    document: Any, latex: str, pythoncom: Any, win32clipboard: Any
) -> tuple[Any, dict[str, Any]]:
    """通过 Equation.DSMT4 的 IDataObject 写入 TeX，绕开宏选区长度限制。"""

    body = _INSERT.strip_math_delimiters(latex).strip()
    source_text = f"$${body}$$"
    target = document.Range(0, 0)
    shape = document.InlineShapes.AddOLEObject(
        ClassType=MATHTYPE_CLASS,
        Range=target,
        DisplayAsIcon=False,
    )
    ole_object = shape.OLEFormat.Object
    data_object = ole_object._oleobj_.QueryInterface(pythoncom.IID_IDataObject)
    clipboard_format = win32clipboard.RegisterClipboardFormat("TeX Input Language")
    format_etc = (
        clipboard_format,
        None,
        pythoncom.DVASPECT_CONTENT,
        -1,
        pythoncom.TYMED_HGLOBAL,
    )
    medium = pythoncom.STGMEDIUM()
    medium.set(pythoncom.TYMED_HGLOBAL, source_text)
    data_object.SetData(format_etc, medium, False)
    return shape, {
        "backend": "equation-dsmt4-idataobject",
        "source_text_sha256": text_sha256(source_text),
        "source_text_length": len(source_text),
        "clipboard_format": "TeX Input Language",
        "object_created": True,
    }


def measure_shape(shape: Any) -> dict[str, float]:
    """在工厂文档中读取 OLE 实际尺寸，避免超高对象进入正式 Word。"""

    return {"height_points": round(float(shape.Height), 2), "width_points": round(float(shape.Width), 2)}


def compile_candidate_with_word(request: dict[str, Any], attempt_dir: Path) -> dict[str, Any]:
    """在全新文档中执行一次真实 MathType 编译事务。"""

    if platform.system() != "Windows":
        return error_result(PERSISTENCE_FAILED, "MathType 公式工厂仅支持 Windows")
    try:
        import pythoncom
        import win32clipboard
        import win32com.client
    except Exception as exc:
        return error_result(PERSISTENCE_FAILED, f"无法加载 Word COM 依赖：{exc}")

    attempt_dir.mkdir(parents=True, exist_ok=False)
    payload_path = attempt_dir / "payload.docx"
    roundtrip_path = attempt_dir / "roundtrip.docx"
    cleanup: dict[str, Any] = {"cleanup_errors": []}
    word = None
    document = None
    coinitialized = False
    try:
        pythoncom.CoInitialize()
        coinitialized = True
        word = win32com.client.DispatchEx("Word.Application")
        word.Visible = False
        word.DisplayAlerts = 0
        if not _INSERT.mathtype_template_loaded(word):
            return error_result(PERSISTENCE_FAILED, "Word 未加载 MathType Commands 2016.dotm")

        document = word.Documents.Add()
        try:
            shape, selection_evidence = create_mathtype_shape_from_latex(
                document,
                request["latex"],
                pythoncom,
                win32clipboard,
            )
        except Exception as exc:
            return error_result(
                LATEX_UNSUPPORTED_OR_MACRO_NO_OBJECT,
                f"Equation.DSMT4 数据对象写入失败：{exc}",
            )

        object_count = int(document.InlineShapes.Count)
        if object_count == 0:
            return error_result(
                LATEX_UNSUPPORTED_OR_MACRO_NO_OBJECT,
                "MathType 宏未生成内嵌对象",
            )
        if object_count != 1:
            return error_result(
                MULTIPLE_OBJECTS_CREATED,
                f"MathType 宏生成了 {object_count} 个对象",
            )
        shape = document.InlineShapes(1)
        object_ok, object_record = _INSERT.verify_shape(shape)
        object_record.update(inline_shape_count=1, ole_count=1)
        if not object_ok:
            return error_result(
                OLE_CONTRACT_INVALID,
                "生成对象不是有效的 Equation.DSMT4 内嵌 OLE",
                object=object_record,
            )
        dimensions = measure_shape(shape)
        object_record["dimensions"] = dimensions
        if dimensions["height_points"] > MAX_SAFE_HEIGHT_POINTS:
            return error_result(
                MATHTYPE_OBJECT_TOO_TALL,
                f"MathType 对象高度 {dimensions['height_points']}pt 超过安全上限 {MAX_SAFE_HEIGHT_POINTS}pt",
                object=object_record,
                diagnostics={"dimensions": dimensions, "max_height_points": MAX_SAFE_HEIGHT_POINTS},
            )
        if dimensions["width_points"] > MAX_SAFE_WIDTH_POINTS:
            return error_result(
                MATHTYPE_OBJECT_TOO_WIDE,
                f"MathType 对象宽度 {dimensions['width_points']}pt 超过安全上限 {MAX_SAFE_WIDTH_POINTS}pt",
                object=object_record,
                diagnostics={"dimensions": dimensions, "max_width_points": MAX_SAFE_WIDTH_POINTS},
            )
        control = document.ContentControls.Add(WD_CONTENT_CONTROL_RICH_TEXT, shape.Range)
        control.Tag = request["content_control_tag"]
        control.Title = request["content_control_tag"]
        if (
            int(control.Type) != WD_CONTENT_CONTROL_RICH_TEXT
            or str(control.Tag) != request["content_control_tag"]
            or int(control.Range.InlineShapes.Count) != 1
        ):
            return error_result(
                OLE_CONTRACT_INVALID,
                "唯一 Rich Text 内容控件创建失败",
                object=object_record,
            )
        document.SaveAs2(
            FileName=str(payload_path),
            FileFormat=WD_FORMAT_DOCUMENT_DEFAULT,
            AddToRecentFiles=False,
        )
        if not _INSERT.safe_close_document(document, cleanup, "payload-save"):
            document = None
            return error_result(PERSISTENCE_FAILED, "保存后的载荷文档关闭失败")
        document = None

        document = _open_docx(word, payload_path, read_only=True)
        controls = _content_controls_by_tag(document, request["content_control_tag"])
        persistence: dict[str, Any] = {
            "content_control_count": len(controls),
            "inline_shape_count": 0,
            "reopen_stable": False,
        }
        if len(controls) == 1:
            persistence["inline_shape_count"] = int(controls[0].Range.InlineShapes.Count)
            if persistence["inline_shape_count"] == 1:
                reopen_ok, reopen_object = _INSERT.verify_shape(
                    controls[0].Range.InlineShapes(1)
                )
                persistence["object"] = reopen_object
                persistence["reopen_stable"] = reopen_ok
        if not persistence["reopen_stable"]:
            return error_result(
                PERSISTENCE_FAILED,
                "保存重开后 MathType OLE 未稳定保留",
                object=object_record,
                persistence=persistence,
            )
        if not _INSERT.safe_close_document(document, cleanup, "payload-reopen"):
            document = None
            return error_result(PERSISTENCE_FAILED, "重开验证文档关闭失败")
        document = None

        shutil.copy2(payload_path, roundtrip_path)
        document = _open_docx(word, roundtrip_path, read_only=False)
        controls = _content_controls_by_tag(document, request["content_control_tag"])
        if len(controls) != 1 or int(controls[0].Range.InlineShapes.Count) != 1:
            return error_result(
                PERSISTENCE_FAILED,
                "回译副本无法唯一定位 MathType OLE",
                object=object_record,
                persistence=persistence,
            )
        shape_range = controls[0].Range.InlineShapes(1).Range.Duplicate
        controls[0].Delete(False)
        if int(shape_range.InlineShapes.Count) != 1:
            return error_result(
                PERSISTENCE_FAILED,
                "解除内容控件后无法唯一定位 MathType OLE",
                object=object_record,
                persistence=persistence,
            )
        shape_range.InlineShapes(1).Range.Select()
        try:
            word.Run(MATHTYPE_MACRO)
        except Exception as exc:
            return error_result(
                ROUNDTRIP_MISMATCH,
                f"MathType 反向回译失败：{exc}",
                object=object_record,
                persistence=persistence,
            )
        roundtrip_tex = str(word.Selection.Range.Text)
        canonical_normalized = _INSERT.normalize_latex_for_compare(
            request["canonical_latex"]
        )
        roundtrip_normalized = _INSERT.normalize_latex_for_compare(roundtrip_tex)
        roundtrip_semantic_hash = _CANDIDATES.semantic_fingerprint(roundtrip_tex)
        content = {
            "roundtrip_tex": roundtrip_tex,
            "canonical_normalized": canonical_normalized,
            "expected_normalized": canonical_normalized,
            "roundtrip_normalized": roundtrip_normalized,
            "candidate_semantic_hash": request["candidate_semantic_hash"],
            "canonical_semantic_hash": request["canonical_semantic_hash"],
            "roundtrip_semantic_hash": roundtrip_semantic_hash,
            "candidate_roundtrip_equivalent": (
                roundtrip_semantic_hash == request["candidate_semantic_hash"]
            ),
            "canonical_semantic_equivalent": (
                roundtrip_semantic_hash == request["canonical_semantic_hash"]
            ),
            "semantic_equivalent": (
                roundtrip_semantic_hash == request["canonical_semantic_hash"]
            ),
        }
        if not content["semantic_equivalent"]:
            return error_result(
                ROUNDTRIP_MISMATCH,
                "MathType 回译结果与 canonical_latex 不一致",
                object=object_record,
                persistence=persistence,
                content=content,
            )
        return {
            "created_object_count": 1,
            "object": object_record,
            "payload_content_control_count": 1,
            "persistence": persistence,
            "content": content,
            "payload_source_path": str(payload_path),
            "diagnostics": {
                "cleanup": cleanup,
                "input_selection": selection_evidence,
            },
        }
    except Exception as exc:
        return error_result(PERSISTENCE_FAILED, f"Word 载荷事务失败：{exc}")
    finally:
        if document is not None:
            _INSERT.safe_close_document(document, cleanup, "factory-finally")
        if word is not None:
            _INSERT.safe_quit_word(word, cleanup)
        if coinitialized:
            pythoncom.CoUninitialize()


Compiler = Callable[[dict[str, Any], Path], dict[str, Any]]


def _attempt_record(
    formula: dict[str, Any],
    candidate: dict[str, Any],
    classified: dict[str, Any],
    manifest_sha256: str,
) -> dict[str, Any]:
    succeeded = classified["state"] == PASS
    object_record = (
        dict(classified["object"])
        if isinstance(classified.get("object"), dict)
        else {}
    )
    persistence = (
        dict(classified["persistence"])
        if isinstance(classified.get("persistence"), dict)
        else {}
    )
    content = (
        dict(classified["content"])
        if isinstance(classified.get("content"), dict)
        else {}
    )
    object_record.setdefault("prog_id", None)
    object_record.setdefault("embedded", False)
    object_record.setdefault("inline_shape_count", 1 if succeeded else 0)
    object_record.setdefault("ole_count", 1 if succeeded else 0)
    persistence.setdefault("reopen_stable", False)
    persistence.setdefault("content_control_count", 0)
    persistence.setdefault("inline_shape_count", 0)
    content.setdefault("semantic_equivalent", False)
    content.setdefault("canonical_semantic_equivalent", False)
    content.setdefault("roundtrip_tex", None)
    set_state(object_record, PASS if succeeded else FAIL)
    set_state(persistence, PASS if succeeded else FAIL)
    set_state(content, PASS if succeeded else FAIL)
    record = {
        "candidate_id": candidate["candidate_id"],
        "latex": candidate["latex"],
        "latex_hash": candidate["latex_hash"],
        "canonical_semantic_hash": candidate["canonical_semantic_hash"],
        "candidate_semantic_hash": candidate["candidate_semantic_hash"],
        "semantic_transform_verified": candidate["semantic_transform_verified"],
        "transform_steps": candidate["transform_steps"],
        "source_state": candidate["source_state"],
        "input_binding": {
            "candidate_manifest_sha256": manifest_sha256,
            "canonical_latex_hash": formula["canonical_latex_hash"],
            "candidate_latex_hash": candidate["latex_hash"],
        },
        "error_code": classified.get("error_code"),
        "error": classified.get("error"),
        "object": object_record,
        "persistence": persistence,
        "content": content,
        "payload_content_control_count": classified.get(
            "payload_content_control_count"
        ),
        "diagnostics": classified.get("diagnostics", []),
        "attempt": {"committed": succeeded},
        "rollback": {
            "performed": not succeeded,
            "snapshot_unchanged": not succeeded,
            "marker_preserved": None,
        },
        "root_cause": classified.get("error_code"),
        "errors": (
            []
            if succeeded
            else [
                {
                    "code": classified.get("error_code"),
                    "message": classified.get("error"),
                }
            ]
        ),
    }
    set_state(record, classified["state"])
    return record


def build_payloads(
    formulas: list[dict[str, Any]],
    *,
    manifest_record: dict[str, Any],
    staging_root: Path,
    final_payload_dir: Path,
    compiler: Compiler,
) -> tuple[list[dict[str, Any]], Path]:
    """逐候选编译，在私有暂存区中只保留每个公式的首个成功载荷。"""

    staging_payload_dir = staging_root / "payloads"
    attempts_root = staging_root / "attempts"
    staging_payload_dir.mkdir()
    attempts_root.mkdir()
    results: list[dict[str, Any]] = []
    for formula_index, formula in enumerate(formulas, start=1):
        item: dict[str, Any] = {
            "formula_id": formula["formula_id"],
            "canonical_latex": formula["canonical_latex"],
            "canonical_latex_hash": formula["canonical_latex_hash"],
            "canonical_semantic_hash": formula["canonical_semantic_hash"],
            "content_control_tag": formula["content_control_tag"],
            "payload_content_control_tag": formula["content_control_tag"],
            "source_state": formula["source_state"],
            "review_reasons": formula["review_reasons"],
            "fallback_allowed": formula["fallback_allowed"],
            "selected_candidate_id": None,
            "payload_docx": None,
            "payload_docx_path": None,
            "payload_docx_sha256": None,
            "payload_content_control_count": 0,
            "object": None,
            "persistence": None,
            "content": None,
            "candidates": [],
            "errors": [],
            "root_cause": None,
            "attempt": {"committed": False},
            "rollback": {
                "performed": True,
                "snapshot_unchanged": True,
                "marker_preserved": None,
            },
            "input_binding": {
                "candidate_manifest_sha256": manifest_record["sha256"],
                "canonical_latex_hash": formula["canonical_latex_hash"],
                "canonical_semantic_hash": formula["canonical_semantic_hash"],
            },
        }
        selected = False
        for candidate_index, candidate in enumerate(formula["candidates"], start=1):
            attempt_dir = (
                attempts_root
                / f"{formula_index:04d}-{safe_filename(formula['formula_id'])}"
                / f"{candidate_index:04d}-{safe_filename(candidate['candidate_id'])}"
            )
            request = {
                "formula_id": formula["formula_id"],
                "canonical_latex": formula["canonical_latex"],
                "canonical_latex_hash": formula["canonical_latex_hash"],
                "content_control_tag": formula["content_control_tag"],
                **candidate,
            }
            try:
                raw_result = compiler(request, attempt_dir)
            except Exception as exc:
                raw_result = error_result(
                    PERSISTENCE_FAILED, f"MathType 编译后端异常：{exc}"
                )
            classified = classify_compiler_result(raw_result, request)
            attempt = _attempt_record(
                formula, candidate, classified, manifest_record["sha256"]
            )
            item["candidates"].append(attempt)
            if classified["state"] != PASS:
                item["errors"].append(
                    {
                        "candidate_id": candidate["candidate_id"],
                        "error_code": classified["error_code"],
                        "error": classified["error"],
                    }
                )
                continue

            payload_name = (
                f"{safe_filename(formula['formula_id'])}."
                f"{formula['canonical_latex_hash'][:12]}.payload.docx"
            )
            staged_payload = staging_payload_dir / payload_name
            temporary_payload = staged_payload.with_suffix(".docx.tmp")
            shutil.copy2(Path(classified["payload_source_path"]), temporary_payload)
            os.replace(temporary_payload, staged_payload)
            payload_hash = file_sha256(staged_payload)
            final_payload = final_payload_dir / payload_name
            payload_record = {
                "path": str(final_payload.resolve()),
                "sha256": payload_hash,
                "size_bytes": staged_payload.stat().st_size,
            }
            item.update(
                {
                    "selected_candidate_id": candidate["candidate_id"],
                    "payload_docx": payload_record,
                    "payload_docx_path": payload_record["path"],
                    "payload_docx_sha256": payload_hash,
                    "payload_content_control_count": 1,
                    "object": classified["object"],
                    "persistence": classified["persistence"],
                    "content": classified["content"],
                    "attempt": {"committed": True},
                    "rollback": {
                        "performed": False,
                        "snapshot_unchanged": False,
                        "marker_preserved": None,
                    },
                    "root_cause": None,
                }
            )
            set_state(item, PASS)
            selected = True
            break
        if not selected:
            set_state(item, FALLBACK if formula["fallback_allowed"] else FAIL)
            item["root_cause"] = (
                item["errors"][-1]["error_code"] if item["errors"] else None
            )
            item["object"] = {
                "state": FAIL,
                "status": FAIL,
                "prog_id": None,
                "embedded": False,
                "inline_shape_count": 0,
                "ole_count": 0,
            }
            item["persistence"] = {
                "state": FAIL,
                "status": FAIL,
                "reopen_stable": False,
                "content_control_count": 0,
                "inline_shape_count": 0,
            }
            item["content"] = {
                "state": FAIL,
                "status": FAIL,
                "semantic_equivalent": False,
                "canonical_semantic_equivalent": False,
                "roundtrip_tex": None,
            }
        results.append(item)
        percent = 40 + round(formula_index / len(formulas) * 14)
        print(
            json.dumps(
                {
                    "type": "progress",
                    "percent": percent,
                    "message": "正在生成并回译 MathType 公式载荷",
                    "stage": {
                        "id": "create-mathtype",
                        "label": "创建 MathType",
                        "state": "running",
                        "current": formula_index,
                        "total": len(formulas),
                        "unit": "个不同公式",
                    },
                },
                ensure_ascii=False,
                separators=(",", ":"),
            ),
            flush=True,
        )
    return results, staging_payload_dir


def derive_report_state(
    formulas: list[dict[str, Any]], *, requires_manual_review: bool = False
) -> str:
    states = [item.get("state") for item in formulas]
    if FAIL in states:
        return FAIL
    if FALLBACK in states:
        return FALLBACK
    if requires_manual_review or REVIEW in states:
        return REVIEW
    return PASS


def _write_json_staged(path: Path, payload: dict[str, Any]) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        return temporary
    except Exception:
        temporary.unlink(missing_ok=True)
        raise


def execute(
    manifest_path: Path,
    payload_dir: Path,
    report_path: Path,
    *,
    compiler: Compiler = compile_candidate_with_word,
) -> dict[str, Any]:
    """编译、验证并以拒绝覆盖方式发布载荷目录和证据报告。"""

    manifest_path = manifest_path.resolve()
    payload_dir = payload_dir.resolve()
    report_path = report_path.resolve()
    if not manifest_path.is_file():
        raise FileNotFoundError(f"候选清单不存在：{manifest_path}")
    if payload_dir.exists():
        raise FileExistsError(f"载荷目录已存在，拒绝覆盖：{payload_dir}")
    if report_path.exists():
        raise FileExistsError(f"报告已存在，拒绝覆盖：{report_path}")
    if manifest_path == report_path:
        raise ValueError("候选清单与报告路径不能相同")
    manifest_bytes = manifest_path.read_bytes()
    try:
        payload = json.loads(manifest_bytes.decode("utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"候选清单不是有效 UTF-8 JSON：{exc}") from exc
    if not isinstance(payload, dict):
        raise ValueError("候选清单 JSON 顶层必须是对象")
    formulas = normalize_manifest(payload)
    manifest_record = {
        "path": str(manifest_path),
        "sha256": bytes_sha256(manifest_bytes),
        "size_bytes": len(manifest_bytes),
    }
    payload_dir.parent.mkdir(parents=True, exist_ok=True)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    staging_root = Path(
        tempfile.mkdtemp(prefix=".pdf2word-mathtype-factory-", dir=payload_dir.parent)
    )
    report_temporary: Path | None = None
    payload_published = False
    try:
        formula_results, staging_payload_dir = build_payloads(
            formulas,
            manifest_record=manifest_record,
            staging_root=staging_root,
            final_payload_dir=payload_dir,
            compiler=compiler,
        )
        requires_manual_review = payload.get("requires_manual_review") is True
        state = derive_report_state(
            formula_results, requires_manual_review=requires_manual_review
        )
        counts = {
            "formula_count": len(formula_results),
            "payload_count": sum(item["state"] == PASS for item in formula_results),
            "pass_count": sum(item["state"] == PASS for item in formula_results),
            "review_count": sum(item["state"] == REVIEW for item in formula_results),
            "fallback_count": sum(item["state"] == FALLBACK for item in formula_results),
            "fail_count": sum(item["state"] == FAIL for item in formula_results),
            "candidate_attempt_count": sum(
                len(item["candidates"]) for item in formula_results
            ),
        }
        report: dict[str, Any] = {
            "schema_version": SCHEMA_VERSION,
            "generator": GENERATOR,
            "generated_at": utc_now(),
            "status_scope": (
                "仅证明独立单公式 MathType 载荷的 OLE 合同、保存重开与 "
                "canonical_latex 回译门禁，不代表最终 Word 的锚点或版面通过"
            ),
            "inputs": {"candidate_manifest": manifest_record},
            "payload_dir": str(payload_dir),
            "outputs": {
                "payload_dir": {"path": str(payload_dir)},
                "report": {"path": str(report_path)},
            },
            "counts": counts,
            "requires_manual_review": requires_manual_review,
            "formulas": formula_results,
        }
        set_state(report, state)
        report_temporary = _write_json_staged(report_path, report)
        os.replace(staging_payload_dir, payload_dir)
        payload_published = True
        try:
            os.replace(report_temporary, report_path)
            report_temporary = None
        except Exception:
            shutil.rmtree(payload_dir)
            payload_published = False
            raise
        return report
    finally:
        if report_temporary is not None:
            report_temporary.unlink(missing_ok=True)
        shutil.rmtree(staging_root, ignore_errors=True)


def build_parser() -> argparse.ArgumentParser:
    parser = ChineseArgumentParser(
        description="在干净 Word 文档中编译并验证单公式 MathType 载荷",
        usage="%(prog)s [-h] --payload-dir 目录 --report 报告.json 候选清单.json",
        add_help=False,
    )
    parser._positionals.title = "位置参数"
    parser._optionals.title = "选项"
    parser.add_argument("manifest", type=Path, metavar="候选清单.json")
    parser.add_argument(
        "--payload-dir", type=Path, required=True, metavar="目录", help="单公式载荷输出目录"
    )
    parser.add_argument(
        "--report", type=Path, required=True, metavar="报告.json", help="工厂证据报告"
    )
    parser.add_argument("-h", "--help", action="help", help="显示帮助信息并退出")
    return parser


def main(argv: list[str] | None = None) -> int:
    configure_stdio()
    args = build_parser().parse_args(argv)
    try:
        report = execute(args.manifest, args.payload_dir, args.report)
    except Exception as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return 1
    print(
        f"MathType 载荷工厂状态：{report['state']}；"
        f"公式 {report['counts']['formula_count']} 条，"
        f"已发布 {report['counts']['payload_count']} 条；"
        f"报告：{args.report.resolve()}"
    )
    if report["state"] == PASS:
        return 0
    if report["state"] in (REVIEW, FALLBACK):
        return 2
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
