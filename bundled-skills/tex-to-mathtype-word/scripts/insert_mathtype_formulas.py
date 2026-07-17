#!/usr/bin/env python3
"""按唯一文本标记把 TeX 公式插入为可编辑 MathType OLE 对象。"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
import os
import platform
import re
import shutil
import sys
import tempfile
import time
import unicodedata
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


PASS = "PASS"
REVIEW = "REVIEW"
FALLBACK = "FALLBACK"
FAIL = "FAIL"
PUBLIC_STATES = frozenset((PASS, REVIEW, FALLBACK, FAIL))

WD_CONTENT_CONTROL_RICH_TEXT = 0
WD_DO_NOT_SAVE_CHANGES = 0
WD_FIND_STOP = 0
WD_INLINE_SHAPE_EMBEDDED_OLE_OBJECT = 1
WD_PARAGRAPH_ALIGNMENT_CENTER = 1
MATHTYPE_CLASS = "Equation.DSMT4"
MATHTYPE_MACRO = "MathType Commands 2016.dotm!MTCommand_TeXToggle"
MAX_CONTENT_CONTROL_NAME = 64
VALID_FORMULA_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
FORMULA_MARKER_TOKEN = re.compile(
    r"\[\[(?P<formula_id>[A-Za-z0-9][A-Za-z0-9._:-]{0,127})\]\]"
)
DISPLAY_LAYOUT_WHITESPACE = re.compile(r"^[ \t]*$")


class ChineseArgumentParser(argparse.ArgumentParser):
    """将 argparse 的固定帮助标题改为简体中文。"""

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


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def set_public_state(record: dict[str, Any], state: str) -> None:
    """同时写入新旧字段，且禁止产生协议之外的公开状态。"""

    if state not in PUBLIC_STATES:
        raise ValueError(f"无效公开状态：{state}")
    record["state"] = state
    record["status"] = state


def load_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8-sig") as handle:
        payload = json.load(handle)
    if not isinstance(payload, dict):
        raise ValueError("公式清单 JSON 顶层必须是对象")
    return payload


def stable_content_control_name(formula_id: str) -> str:
    normalized = unicodedata.normalize("NFKC", formula_id).upper()
    normalized = re.sub(r"[^A-Z0-9]+", "_", normalized).strip("_") or "FORMULA"
    value = f"PDF2WORD_{normalized}"
    if len(value) <= MAX_CONTENT_CONTROL_NAME:
        return value
    suffix = hashlib.sha256(formula_id.encode("utf-8")).hexdigest()[:12].upper()
    keep = MAX_CONTENT_CONTROL_NAME - len("PDF2WORD__") - len(suffix)
    return f"PDF2WORD_{normalized[:keep]}_{suffix}"


def normalize_status(value: Any) -> str | None:
    """规范化清单状态；未知值保留为 None，以便按安全策略拒绝。"""

    if not isinstance(value, str):
        return None
    normalized = value.strip().upper()
    return normalized or None


def normalize_source_type(value: Any) -> str:
    if not isinstance(value, str):
        return "tex"
    normalized = value.strip().lower()
    return normalized or "tex"


def normalize_equation_number(value: Any, prefix: str) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError(f"{prefix}的 equation_number 必须是字符串或 null")
    if not value or value != value.strip():
        raise ValueError(f"{prefix}的 equation_number 不能为空且不能带首尾空白")
    if len(value) > 64:
        raise ValueError(f"{prefix}的 equation_number 不能超过 64 个字符")
    if any(character.isspace() or ord(character) < 32 for character in value):
        raise ValueError(f"{prefix}的 equation_number 不能包含空白或控制字符")
    if "[[" in value or "]]" in value:
        raise ValueError(f"{prefix}的 equation_number 不能包含公式标记分隔符")
    return value


def normalize_manifest(
    payload: dict[str, Any], *, allow_review_candidates: bool = False
) -> list[dict[str, Any]]:
    raw_formulas = payload.get("formulas")
    if not isinstance(raw_formulas, list) or not raw_formulas:
        raise ValueError("公式清单中的 formulas 必须是非空数组")

    formulas: list[dict[str, Any]] = []
    formula_ids: set[str] = set()
    control_names: set[str] = set()
    for index, raw in enumerate(raw_formulas, start=1):
        if not isinstance(raw, dict):
            raise ValueError(f"第 {index} 个公式条目必须是对象")
        formula_id = raw.get("formula_id")
        expected_math_latex = raw.get("math_latex")
        if not isinstance(expected_math_latex, str) or not expected_math_latex.strip():
            expected_math_latex = raw.get("body_latex")
        kind = raw.get("kind", "display")
        if not isinstance(formula_id, str) or not VALID_FORMULA_ID.fullmatch(formula_id):
            raise ValueError(
                f"第 {index} 个公式的 formula_id 无效；仅允许 1 至 128 个字母、"
                "数字、点、下划线、冒号或连字符"
            )
        if formula_id in formula_ids:
            raise ValueError(f"formula_id 重复：{formula_id}")
        if not isinstance(expected_math_latex, str) or not expected_math_latex.strip():
            raise ValueError(f"公式 {formula_id} 缺少有效 body_latex")
        if kind not in ("display", "inline"):
            raise ValueError(f"公式 {formula_id} 的 kind 必须是 display 或 inline")

        source_type = normalize_source_type(raw.get("source_type", "tex"))
        source_status = normalize_status(raw.get("status"))
        final_mathtype_eligible = raw.get("final_mathtype_eligible")
        review_candidate = False
        if source_type == "ocr":
            final_eligible = (
                source_status == PASS and final_mathtype_eligible is True
            )
            review_candidate = (
                source_status == REVIEW and final_mathtype_eligible is False
            )
            if not final_eligible and not review_candidate:
                raise ValueError(
                    f"OCR 公式 {formula_id} 的 status/final_mathtype_eligible "
                    "不是可安全插入的最终资格组合；仅允许 PASS/true，"
                    "或显式候选模式下的 REVIEW/false"
                )
            if review_candidate and not allow_review_candidates:
                raise ValueError(
                    f"OCR 公式 {formula_id} 是 REVIEW 候选，默认拒绝插入；"
                    "如仅需生成候选 DOCX，请显式传入 --allow-review-candidates"
                )

        declared_control_name = raw.get("content_control_tag")
        if declared_control_name is None:
            control_name = stable_content_control_name(formula_id)
        elif (
            not isinstance(declared_control_name, str)
            or not declared_control_name
            or len(declared_control_name) > MAX_CONTENT_CONTROL_NAME
        ):
            raise ValueError(f"公式 {formula_id} 的 content_control_tag 无效")
        else:
            control_name = declared_control_name
        if control_name in control_names:
            raise ValueError(f"公式 ID 规范化后内容控件名称冲突：{control_name}")
        formula_ids.add(formula_id)
        control_names.add(control_name)

        expected_math_latex = expected_math_latex.strip()
        tex_hash = raw.get("tex_hash")
        if not isinstance(tex_hash, str) or not tex_hash:
            tex_hash = hashlib.sha256(expected_math_latex.encode("utf-8")).hexdigest()
        formulas.append(
            {
                "formula_id": formula_id,
                "body_latex": expected_math_latex,
                "expected_math_latex": expected_math_latex,
                "kind": kind,
                "equation_number": normalize_equation_number(
                    raw.get("equation_number"), f"公式 {formula_id}"
                ),
                "tex_hash": tex_hash,
                "marker": f"[[{formula_id}]]",
                "content_control_name": control_name,
                "match_confidence": raw.get("match_confidence"),
                "source_type": source_type,
                "source_status": source_status,
                "final_mathtype_eligible": final_mathtype_eligible,
                "review_candidate": review_candidate,
                "backend": raw.get("backend"),
                "asset_hash": raw.get("asset_sha256", raw.get("asset_hash")),
                "model_confidence": raw.get("model_confidence"),
                "ocr_agent": raw.get("ocr_agent")
                if isinstance(raw.get("ocr_agent"), dict)
                else None,
                "independent_review": raw.get("independent_review")
                if isinstance(raw.get("independent_review"), dict)
                else None,
                "provenance": raw.get("provenance")
                if isinstance(raw.get("provenance"), dict)
                else None,
                "review_reasons": raw.get("review_reasons")
                if isinstance(raw.get("review_reasons"), list)
                else None,
            }
        )
    display_slot_registry = {
        formula["formula_id"]: {
            "formula_id": formula["formula_id"],
            "tag": formula["content_control_name"],
            "equation_number": formula["equation_number"],
        }
        for formula in formulas
        if formula["kind"] == "display"
    }
    for formula in formulas:
        formula["display_slot_registry"] = display_slot_registry
    return formulas


def normalize_registry_mathtype(
    payload: dict[str, Any], *, allow_review_candidates: bool
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """从统一注册表读取 MathType 资格与 Tag，不再在插入阶段推导身份。"""

    registry_state = normalize_status(payload.get("state", payload.get("status")))
    if registry_state not in PUBLIC_STATES or registry_state == FAIL:
        raise ValueError("统一公式注册表顶层状态无效或为 FAIL")
    raw_formulas = payload.get("formulas")
    if not isinstance(raw_formulas, list):
        raise ValueError("统一公式注册表缺少 formulas 数组")
    transformed: list[dict[str, Any]] = []
    registry_states: dict[str, str] = {}
    image_formula_ids: list[str] = []
    seen_ids: set[str] = set()
    for index, raw in enumerate(raw_formulas, start=1):
        if not isinstance(raw, dict):
            raise ValueError(f"统一公式注册表第 {index} 条公式必须是对象")
        formula_id = raw.get("formula_id")
        if not isinstance(formula_id, str) or not VALID_FORMULA_ID.fullmatch(formula_id):
            raise ValueError(f"统一公式注册表第 {index} 条公式的 formula_id 无效")
        if formula_id in seen_ids:
            raise ValueError(f"统一公式注册表 formula_id 重复：{formula_id}")
        seen_ids.add(formula_id)
        state = normalize_status(raw.get("state", raw.get("status")))
        if state not in PUBLIC_STATES:
            raise ValueError(f"统一公式注册表公式 {formula_id} 的状态无效")
        expected = raw.get("expected")
        if not isinstance(expected, dict):
            raise ValueError(f"统一公式注册表公式 {formula_id} 缺少 expected")
        payload_type = expected.get("payload_type")
        if payload_type == "image":
            image_formula_ids.append(formula_id)
            continue
        if payload_type != "mathtype":
            raise ValueError(f"统一公式注册表公式 {formula_id} 的 payload_type 无效")
        if state not in (PASS, REVIEW):
            raise ValueError(
                f"统一公式注册表公式 {formula_id} 状态为 {state}，不得进入 MathType"
            )
        if state == REVIEW and not allow_review_candidates:
            raise ValueError(
                f"统一公式注册表公式 {formula_id} 为 REVIEW；"
                "仅可在 --allow-review-candidates 模式下生成候选输出"
            )
        tag = expected.get("content_control_tag")
        if not isinstance(tag, str) or not tag or len(tag) > MAX_CONTENT_CONTROL_NAME:
            raise ValueError(
                f"统一公式注册表公式 {formula_id} 缺少有效 expected.content_control_tag"
            )
        if expected.get("embedded") is not True:
            raise ValueError(f"统一公式注册表公式 {formula_id} 未声明 embedded=true")
        if expected.get("ole_prog_id") != MATHTYPE_CLASS:
            raise ValueError(
                f"统一公式注册表公式 {formula_id} 的 ole_prog_id 不是 {MATHTYPE_CLASS}"
            )
        source = raw.get("source")
        if not isinstance(source, dict):
            raise ValueError(f"统一公式注册表公式 {formula_id} 缺少 source")
        latex = source.get("latex")
        if not isinstance(latex, str) or not latex.strip():
            raise ValueError(f"统一公式注册表公式 {formula_id} 缺少可用 LaTeX")
        source_type = normalize_source_type(source.get("type"))
        if source_type not in ("tex", "ocr"):
            raise ValueError(f"统一公式注册表公式 {formula_id} 的 MathType 来源类型无效")
        if source.get("eligibility") is not True:
            raise ValueError(f"统一公式注册表公式 {formula_id} 未具备 MathType 资格")
        latex_hash = source.get("latex_hash")
        actual_latex_hash = hashlib.sha256(latex.strip().encode("utf-8")).hexdigest()
        if not isinstance(latex_hash, str) or latex_hash.lower() != actual_latex_hash:
            raise ValueError(f"统一公式注册表公式 {formula_id} 的 LaTeX 哈希不一致")
        transformed.append(
            {
                "formula_id": formula_id,
                "math_latex": latex,
                "tex_hash": actual_latex_hash,
                "kind": raw.get("kind"),
                "equation_number": raw.get("equation_number"),
                "match_confidence": raw.get("match_confidence"),
                "source_type": source_type,
                "status": source.get("status", state),
                "final_mathtype_eligible": source.get(
                    "final_mathtype_eligible", source.get("eligibility")
                ),
                "backend": source.get("backend"),
                "asset_sha256": safe_value(lambda raw=raw: raw["asset"]["sha256"]),
                "model_confidence": source.get("model_confidence"),
                "ocr_agent": source.get("ocr_agent"),
                "independent_review": source.get("independent_review"),
                "provenance": raw.get("provenance"),
                "content_control_tag": tag,
            }
        )
        registry_states[formula_id] = state

    formulas = (
        normalize_manifest({"formulas": transformed}) if transformed else []
    )
    for formula in formulas:
        formula["registry_state"] = registry_states[formula["formula_id"]]
        if formula["registry_state"] == REVIEW:
            formula["review_candidate"] = True
    safety = {
        "is_registry": True,
        "declared_status": normalize_status(payload.get("state", payload.get("status"))),
        "candidate_formula_count": len(formulas),
        "image_formula_ids": image_formula_ids,
        "review_candidate_formula_ids": [
            formula["formula_id"] for formula in formulas if formula["review_candidate"]
        ],
        "coverage_verified": True,
        "coverage_complete": True,
        "final_pass_blocked": bool(
            image_formula_ids
            or any(formula["review_candidate"] for formula in formulas)
            or normalize_status(payload.get("state", payload.get("status"))) != PASS
        ),
        "reasons": [],
    }
    if image_formula_ids:
        safety["reasons"].append("注册表仍含必须走图片回退的公式")
    if safety["review_candidate_formula_ids"]:
        safety["reasons"].append("注册表含 REVIEW MathType 候选")
    return formulas, safety


def inspect_manifest_safety(
    payload: dict[str, Any], formulas: list[dict[str, Any]]
) -> dict[str, Any]:
    """记录 OCR 清单的全量覆盖状态，并阻止候选版被标为最终通过。

    这里不把存在图片回退项当成插入错误：自动合格的 OCR 公式仍可先回填
    MathType，后续由图片回退流程处理其余项。只是此阶段绝不能输出最终 PASS。
    """

    raw_formulas = payload.get("formulas")
    top_source_type = normalize_source_type(payload.get("source_type"))
    is_ocr_manifest = top_source_type == "ocr" or any(
        formula["source_type"] == "ocr" for formula in formulas
    )
    result: dict[str, Any] = {
        "is_ocr_manifest": is_ocr_manifest,
        "declared_status": normalize_status(payload.get("status")),
        "declared_formula_count": payload.get("formula_count"),
        "candidate_formula_count": len(formulas),
        "rejected_formula_count": 0,
        "coverage_verified": True,
        "coverage_complete": True,
        "review_candidate_formula_ids": [
            formula["formula_id"] for formula in formulas if formula["review_candidate"]
        ],
        "final_pass_blocked": False,
        "reasons": [],
    }
    if not is_ocr_manifest:
        return result

    rejected_raw = payload.get("rejected_formulas")
    if not isinstance(rejected_raw, list):
        rejected_raw = []
        result["coverage_verified"] = False
        result["reasons"].append("OCR 清单缺少 rejected_formulas 数组")

    rejected_ids: list[str] = []
    for index, item in enumerate(rejected_raw, start=1):
        formula_id = item.get("formula_id") if isinstance(item, dict) else None
        if not isinstance(formula_id, str) or not formula_id.strip():
            result["coverage_verified"] = False
            result["reasons"].append(
                f"rejected_formulas 第 {index} 项缺少有效 formula_id"
            )
            continue
        rejected_ids.append(formula_id.strip())
    result["rejected_formula_count"] = len(rejected_ids)
    result["rejected_formula_ids"] = rejected_ids

    candidate_ids = [formula["formula_id"] for formula in formulas]
    if len(set(candidate_ids)) != len(candidate_ids):
        result["coverage_verified"] = False
        result["reasons"].append("OCR 清单 formulas 存在重复 formula_id")
    if len(set(rejected_ids)) != len(rejected_ids):
        result["coverage_verified"] = False
        result["reasons"].append("OCR 清单 rejected_formulas 存在重复 formula_id")
    overlap = sorted(set(candidate_ids) & set(rejected_ids))
    if overlap:
        result["coverage_verified"] = False
        result["reasons"].append(
            "同一公式同时位于 formulas 与 rejected_formulas：" + ", ".join(overlap)
        )

    declared_count = payload.get("formula_count")
    if isinstance(declared_count, bool) or not isinstance(declared_count, int) or declared_count < 0:
        result["coverage_verified"] = False
        result["reasons"].append("OCR 清单缺少有效的 formula_count")
    elif declared_count != len(candidate_ids) + len(rejected_ids):
        result["coverage_complete"] = False
        result["reasons"].append(
            "formula_count 与 formulas/rejected_formulas 的全量公式数不一致"
        )

    candidate_count = payload.get("candidate_count")
    if candidate_count is not None and (
        isinstance(candidate_count, bool)
        or not isinstance(candidate_count, int)
        or candidate_count != len(candidate_ids)
    ):
        result["coverage_verified"] = False
        result["reasons"].append("candidate_count 与 formulas 数量不一致")

    if result["declared_status"] not in (PASS, REVIEW):
        result["coverage_verified"] = False
        result["reasons"].append("OCR 清单 status 必须为 PASS 或 REVIEW")
    elif result["declared_status"] != PASS:
        result["reasons"].append("OCR 清单状态不是 PASS")

    if result["review_candidate_formula_ids"]:
        result["reasons"].append("本次包含非最终合格的 OCR REVIEW 候选")
    if rejected_ids:
        result["reasons"].append("OCR 清单含待图片回退的被拒绝公式")

    result["coverage_complete"] = bool(
        result["coverage_verified"] and result["coverage_complete"]
    )
    result["final_pass_blocked"] = bool(
        not result["coverage_complete"]
        or result["declared_status"] != PASS
        or result["review_candidate_formula_ids"]
        or rejected_ids
    )
    return result


def formula_report_context(formula: dict[str, Any]) -> dict[str, Any]:
    """把清单来源资格写入插入证据，供后续独立门禁复核。"""

    source: dict[str, Any] = {
        "source_type": formula["source_type"],
        "manifest_status": formula["source_status"],
        "final_mathtype_eligible": formula["final_mathtype_eligible"],
        "review_candidate": formula["review_candidate"],
    }
    if formula["source_type"] != "ocr":
        return {"source": source}

    source.update(
        {
            "backend": formula["backend"],
            "asset_sha256": formula["asset_hash"],
            "model_confidence": formula["model_confidence"],
        }
    )
    if formula["ocr_agent"] is not None:
        source["ocr_agent"] = formula["ocr_agent"]
    if formula["independent_review"] is not None:
        source["independent_review"] = formula["independent_review"]
    if formula["provenance"] is not None:
        source["provenance"] = formula["provenance"]

    ocr: dict[str, Any] = {
        "backend": formula["backend"],
        "asset_sha256": formula["asset_hash"],
        "model_confidence": formula["model_confidence"],
        "manifest_status": formula["source_status"],
        "final_mathtype_eligible": formula["final_mathtype_eligible"],
        "review_candidate": formula["review_candidate"],
    }
    if formula["ocr_agent"] is not None:
        ocr["ocr_agent"] = formula["ocr_agent"]
    if formula["independent_review"] is not None:
        ocr["independent_review"] = formula["independent_review"]
    return {"source": source, "ocr": ocr}


def find_literal_ranges(document: Any, text: str) -> list[Any]:
    """用 Word 自身的字面量查找在正文主故事中定位文本。"""

    if not text:
        raise ValueError("查找文本不能为空")
    story = document.Content.Duplicate
    story_end = int(story.End)
    matches: list[Any] = []
    search_start = int(story.Start)
    while search_start < story_end:
        search = document.Range(search_start, story_end)
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
        if not found:
            break
        match = search.Duplicate
        match_start = int(match.Start)
        next_start = int(match.End)
        if match_start < search_start or next_start > story_end:
            break
        if str(match.Text) != text:
            raise RuntimeError("Word 字面量查找返回了非精确文本，拒绝继续回填")
        if next_start <= search_start:
            raise RuntimeError("Word 字面量查找未向前推进，拒绝继续回填")
        matches.append(match)
        search_start = next_start
    return matches


def safe_value(factory: Any, default: Any = None) -> Any:
    try:
        return factory()
    except Exception:
        return default


def calculate_layout_compensation(
    original_space_after_pt: float,
    original_line_spacing_pt: float,
    object_height_pt: float,
) -> dict[str, float]:
    """计算公式对象替换占位文本后应保留的段后距。"""

    values = {
        "original_space_after_pt": original_space_after_pt,
        "original_line_spacing_pt": original_line_spacing_pt,
        "object_height_pt": object_height_pt,
    }
    for name, value in values.items():
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError(f"{name} 必须是数值")
        if not math.isfinite(float(value)) or float(value) < 0:
            raise ValueError(f"{name} 必须是非负有限数值")
    if float(original_line_spacing_pt) == 0 or float(object_height_pt) == 0:
        raise ValueError("原始行距和公式对象高度必须大于 0")

    object_height_increase = max(
        0.0, float(object_height_pt) - float(original_line_spacing_pt)
    )
    target_space_after = max(
        0.0, float(original_space_after_pt) - object_height_increase
    )
    return {
        "object_height_increase_pt": round(object_height_increase, 3),
        "target_space_after_pt": round(target_space_after, 3),
    }


def capture_paragraph_layout(paragraph_range: Any) -> dict[str, Any]:
    paragraph_format = paragraph_range.ParagraphFormat
    space_after = safe_value(lambda: float(paragraph_format.SpaceAfter))
    line_spacing = safe_value(lambda: float(paragraph_format.LineSpacing))
    evidence: dict[str, Any] = {
        "original_space_after_pt": (
            round(space_after, 3) if isinstance(space_after, float) else None
        ),
        "original_line_spacing_pt": (
            round(line_spacing, 3) if isinstance(line_spacing, float) else None
        ),
        "valid": False,
    }
    try:
        calculate_layout_compensation(space_after, line_spacing, 1.0)
    except (TypeError, ValueError) as exc:
        evidence["error"] = f"无法读取稳定的原始段落占高：{exc}"
        return evidence
    evidence["valid"] = True
    return evidence


def apply_layout_compensation(
    paragraph_range: Any,
    layout_before: dict[str, Any],
    object_height_pt: float,
) -> dict[str, Any]:
    """只扣减公式对象新增占高，不改变对象尺寸、行距或语义内容。"""

    evidence: dict[str, Any] = {
        **layout_before,
        "object_height_pt": round(float(object_height_pt), 3),
        "applied": False,
    }
    if not layout_before.get("valid"):
        evidence["error"] = layout_before.get("error", "原始段落布局证据无效")
        return evidence
    try:
        calculated = calculate_layout_compensation(
            float(layout_before["original_space_after_pt"]),
            float(layout_before["original_line_spacing_pt"]),
            float(object_height_pt),
        )
        evidence.update(calculated)
        paragraph_range.ParagraphFormat.SpaceAfter = calculated[
            "target_space_after_pt"
        ]
        applied = float(paragraph_range.ParagraphFormat.SpaceAfter)
        evidence["applied_space_after_pt"] = round(applied, 3)
        evidence["applied"] = (
            abs(applied - calculated["target_space_after_pt"]) <= 0.1
        )
        if not evidence["applied"]:
            evidence["error"] = "Word 未稳定应用计算后的段后距"
    except Exception as exc:
        evidence["error"] = f"段后距补偿失败：{exc}"
    return evidence


def content_controls_by_tag(document: Any, tag: str) -> list[Any]:
    """用 Count/Item 枚举内容控件，避免全局 SelectContentControlsByTag 卡死。"""

    collection = safe_value(lambda: document.ContentControls)
    if collection is None:
        return []
    count = safe_value(lambda: int(collection.Count), 0)
    controls: list[Any] = []
    for index in range(1, int(count or 0) + 1):
        control = safe_value(lambda index=index: collection.Item(index))
        if control is not None and safe_value(lambda control=control: str(control.Tag), "") == tag:
            controls.append(control)
    return controls


def all_content_control_tags(document: Any) -> Counter[str]:
    collection = safe_value(lambda: document.ContentControls)
    if collection is None:
        return Counter()
    count = safe_value(lambda: int(collection.Count), 0)
    tags: Counter[str] = Counter()
    for index in range(1, int(count or 0) + 1):
        control = safe_value(lambda index=index: collection.Item(index))
        tag = safe_value(lambda control=control: str(control.Tag), "") if control else ""
        if tag:
            tags[tag] += 1
    return tags


def paragraph_body_text(paragraph_range: Any) -> str:
    text = str(paragraph_range.Text)
    while text and text[-1] in ("\r", "\x07"):
        text = text[:-1]
    return text


def inspect_display_marker_paragraph(target: Any, formula: dict[str, Any]) -> dict[str, Any]:
    """在任何修改前验证显示公式槽位及其普通文本编号配对。"""

    paragraph = target.Paragraphs(1).Range
    body_text = paragraph_body_text(paragraph)
    registry = formula.get("display_slot_registry")
    evidence: dict[str, Any] = {
        "valid": False,
        "placement_mode": None,
        "paragraph_text": str(paragraph.Text),
        "equation_number": formula.get("equation_number"),
        "slots": [],
        "errors": [],
    }
    if not isinstance(registry, dict):
        evidence["errors"].append("缺少完整显示公式槽位表")
        return evidence

    matches = list(FORMULA_MARKER_TOKEN.finditer(body_text))
    evidence["slots"] = [match.group("formula_id") for match in matches]
    target_count = sum(
        match.group("formula_id") == formula["formula_id"] for match in matches
    )
    if target_count != 1:
        evidence["errors"].append("同段落中目标显示公式标记必须恰好出现一次")
        return evidence

    if len(matches) == 1:
        before = body_text[: matches[0].start()]
        after = body_text[matches[0].end() :]
        if DISPLAY_LAYOUT_WHITESPACE.fullmatch(before) and DISPLAY_LAYOUT_WHITESPACE.fullmatch(after):
            evidence["placement_mode"] = "marker-exclusive-paragraph"
            evidence["valid"] = True
            return evidence

    evidence["placement_mode"] = "numbered-formula-groups"
    if not matches or not DISPLAY_LAYOUT_WHITESPACE.fullmatch(body_text[: matches[0].start()]):
        evidence["errors"].append("显示公式编号组前不得包含正文或非空白字符")
    for index, match in enumerate(matches):
        formula_id = match.group("formula_id")
        metadata = registry.get(formula_id)
        if not isinstance(metadata, dict):
            evidence["errors"].append(f"显示公式标记不在清单中：{formula_id}")
            continue
        equation_number = metadata.get("equation_number")
        if not isinstance(equation_number, str):
            evidence["errors"].append(
                f"显示公式 {formula_id} 与编号同段落时必须提供 equation_number"
            )
            continue
        segment_end = matches[index + 1].start() if index + 1 < len(matches) else len(body_text)
        trailing = body_text[match.end() : segment_end]
        if trailing.strip(" \t") != equation_number or trailing.count(equation_number) != 1:
            evidence["errors"].append(
                f"显示公式 {formula_id} 后的普通文本编号必须唯一匹配 {equation_number}"
            )
    target_number = formula.get("equation_number")
    count = body_text.count(target_number) if isinstance(target_number, str) else 0
    evidence["numbering_gate"] = {
        "required": True,
        "same_paragraph": True,
        "equation_number": target_number,
        "count_in_paragraph": count,
        "unique_in_paragraph": count == 1,
    }
    if count != 1:
        evidence["errors"].append("目标公式编号在同段落中必须恰好出现一次")
    evidence["valid"] = not evidence["errors"]
    return evidence


def verify_display_host(control: Any, formula: dict[str, Any], placement_mode: str) -> dict[str, Any]:
    """验证 MathType 内容控件宿主未吞入或移动普通文本公式编号。"""

    paragraph = control.Range.Paragraphs(1).Range
    body_text = paragraph_body_text(paragraph)
    equation_number = formula.get("equation_number")
    evidence: dict[str, Any] = {
        "valid": True,
        "placement_mode": placement_mode,
        "equation_number": equation_number,
        "paragraph_text": str(paragraph.Text),
        "ordinary_text_number_preserved": True,
    }
    if placement_mode == "numbered-formula-groups":
        count = body_text.count(equation_number) if isinstance(equation_number, str) else 0
        control_text = safe_value(lambda: str(control.Range.Text), "")
        evidence.update(
            {
                "count_in_paragraph": count,
                "number_inside_formula_control": bool(
                    isinstance(equation_number, str) and equation_number in control_text
                ),
            }
        )
        evidence["ordinary_text_number_preserved"] = bool(
            count == 1 and equation_number not in control_text
        )
        evidence["valid"] = evidence["ordinary_text_number_preserved"]
    return evidence


def shape_evidence(shape: Any) -> dict[str, Any]:
    shape_range = shape.Range
    paragraph = safe_value(lambda: shape_range.Paragraphs(1))
    tab_stops: list[dict[str, Any]] = []
    if paragraph is not None:
        count = safe_value(lambda: int(paragraph.Format.TabStops.Count), 0)
        for index in range(1, count + 1):
            stop = paragraph.Format.TabStops(index)
            tab_stops.append(
                {
                    "position_pt": round(float(stop.Position), 3),
                    "alignment": int(stop.Alignment),
                }
            )
    return {
        "inline_shape_type": int(shape.Type),
        "embedded": int(shape.Type) == WD_INLINE_SHAPE_EMBEDDED_OLE_OBJECT,
        "class_type": safe_value(lambda: str(shape.OLEFormat.ClassType)),
        "prog_id": safe_value(lambda: str(shape.OLEFormat.ProgID)),
        "range_start": int(shape_range.Start),
        "range_end": int(shape_range.End),
        "story_type": safe_value(lambda: int(shape_range.StoryType)),
        "page": safe_value(lambda: int(shape_range.Information(1))),
        "horizontal_position_pt": safe_value(lambda: round(float(shape_range.Information(5)), 3)),
        "vertical_position_pt": safe_value(lambda: round(float(shape_range.Information(6)), 3)),
        "width_pt": round(float(shape.Width), 3),
        "height_pt": round(float(shape.Height), 3),
        "paragraph_style": safe_value(lambda: str(paragraph.Range.Style.NameLocal))
        if paragraph is not None
        else None,
        "paragraph_alignment": safe_value(lambda: int(paragraph.Format.Alignment))
        if paragraph is not None
        else None,
        "tab_stops": tab_stops,
    }


def verify_shape(shape: Any) -> tuple[bool, dict[str, Any]]:
    evidence = shape_evidence(shape)
    valid = (
        evidence["inline_shape_type"] == WD_INLINE_SHAPE_EMBEDDED_OLE_OBJECT
        and evidence["class_type"] == MATHTYPE_CLASS
        and evidence["prog_id"] == MATHTYPE_CLASS
    )
    return valid, evidence


def mathtype_template_loaded(word: Any) -> bool:
    expected = "mathtype commands 2016.dotm"
    return any(str(template.Name).lower() == expected for template in word.Templates)


def convert_formula(word: Any, document: Any, formula: dict[str, Any]) -> dict[str, Any]:
    formula_id = formula["formula_id"]
    marker = formula["marker"]
    result: dict[str, Any] = {
        "formula_id": formula_id,
        "state": FAIL,
        "status": FAIL,
        "source_type": formula["source_type"],
        "attempt": {},
        "rollback": {},
        "anchor": {},
        "object": None,
        "kind": formula["kind"],
        "equation_number": formula.get("equation_number"),
        "marker": marker,
        "tex_hash": formula["tex_hash"],
        "match_confidence": formula["match_confidence"],
        "content_control_tag": formula["content_control_name"],
        "errors": [],
        **formula_report_context(formula),
    }
    matches = find_literal_ranges(document, marker)
    result["marker_count_before"] = len(matches)
    if len(matches) != 1:
        result["errors"].append(f"标记必须恰好出现一次，实际为 {len(matches)} 次")
        return result

    existing_controls = content_controls_by_tag(document, formula["content_control_name"])
    result["content_control_count_before"] = len(existing_controls)
    if existing_controls:
        result["errors"].append("目标内容控件 Tag 已存在")
        return result

    target = matches[0]
    result["anchor"] = {
        "unique": True,
        "story_type": safe_value(lambda: int(target.StoryType)),
        "range_start_before": int(target.Start),
        "range_end_before": int(target.End),
    }
    parent_control = safe_value(lambda: target.ParentContentControl)
    if parent_control is not None:
        result["errors"].append("文本标记已位于内容控件中，拒绝执行嵌套替换")
        return result
    display_placement_mode: str | None = None
    if formula["kind"] == "display":
        paragraph_range = target.Paragraphs(1).Range
        result["anchor"]["paragraph_text_before"] = safe_value(
            lambda: str(paragraph_range.Text), ""
        )
        result["anchor"]["paragraph_alignment_before"] = safe_value(
            lambda: int(paragraph_range.ParagraphFormat.Alignment)
        )
        layout_before = capture_paragraph_layout(paragraph_range)
        result["layout_before"] = layout_before
        if not layout_before["valid"]:
            result["errors"].append(layout_before["error"])
            return result
        display_layout = formula.get("preflight_display_layout")
        if not isinstance(display_layout, dict) or not display_layout.get("valid"):
            result["errors"].append("显示公式段落未通过预检的槽位/编号门禁")
            return result
        result["display_layout_before"] = display_layout
        display_placement_mode = str(display_layout["placement_mode"])
    latex = (
        f"${formula['body_latex']}$"
        if formula["kind"] == "inline"
        else rf"\[{formula['body_latex']}\]"
    )
    target.Text = latex
    target.Select()
    word.Run(MATHTYPE_MACRO)

    selection_range = word.Selection.Range.Duplicate
    result["selection_shape_count_after_macro"] = int(selection_range.InlineShapes.Count)
    if selection_range.InlineShapes.Count != 1:
        result["errors"].append(
            "MathType 宏执行后选区内嵌对象数量不是 1，拒绝推断目标对象"
        )
        return result

    shape = selection_range.InlineShapes(1)
    if formula["kind"] == "display" and display_placement_mode == "marker-exclusive-paragraph":
        shape.Range.Paragraphs(1).Format.Alignment = WD_PARAGRAPH_ALIGNMENT_CENTER
    object_ok, object_evidence = verify_shape(shape)
    object_evidence["formula_id"] = formula_id
    object_evidence["tex_hash"] = formula["tex_hash"]
    result["object"] = object_evidence
    if not object_ok:
        result["errors"].append("生成对象不是有效的 Equation.DSMT4 内嵌 OLE")
        return result
    if formula["kind"] == "display":
        layout_compensation = apply_layout_compensation(
            shape.Range.Paragraphs(1).Range,
            result["layout_before"],
            float(shape.Height),
        )
        result["layout_compensation"] = layout_compensation
        if not layout_compensation["applied"]:
            result["errors"].append(
                layout_compensation.get("error", "显示公式段后距补偿失败")
            )
            return result

    control = document.ContentControls.Add(WD_CONTENT_CONTROL_RICH_TEXT, shape.Range)
    control.Tag = formula["content_control_name"]
    control.Title = formula["content_control_name"]
    result["content_control"] = {
        "type": int(control.Type),
        "tag": str(control.Tag),
        "title": str(control.Title),
        "range_start": int(control.Range.Start),
        "range_end": int(control.Range.End),
        "inline_shape_count": int(control.Range.InlineShapes.Count),
    }
    marker_count_after = len(find_literal_ranges(document, marker))
    result["marker_count_after"] = marker_count_after
    if marker_count_after != 0:
        result["errors"].append("转换后原文本标记仍然存在")
    if control.Type != WD_CONTENT_CONTROL_RICH_TEXT:
        result["errors"].append("生成的内容控件不是 Rich Text 类型")
    if control.Tag != formula["content_control_name"]:
        result["errors"].append("生成的内容控件 Tag 不符合预期")
    if control.Title != formula["content_control_name"]:
        result["errors"].append("生成的内容控件 Title 不符合预期")
    if control.Range.InlineShapes.Count != 1:
        result["errors"].append("内容控件内嵌对象数量不是 1")
    if formula["kind"] == "display" and display_placement_mode is not None:
        host = verify_display_host(control, formula, display_placement_mode)
        result["display_host"] = host
        if not host["valid"]:
            result["errors"].append("显示公式的普通文本编号未在同一宿主段落稳定保留")
    if not result["errors"]:
        set_public_state(result, REVIEW if formula["review_candidate"] else PASS)
    return result


def reopen_verify(
    document: Any,
    formula: dict[str, Any],
    expected_space_after_pt: float | None = None,
) -> dict[str, Any]:
    tag = formula["content_control_name"]
    controls = content_controls_by_tag(document, tag)
    evidence: dict[str, Any] = {
        "content_control_count": len(controls),
        "reopen_stable": False,
    }
    if len(controls) != 1:
        evidence["error"] = f"重开后 Tag={tag} 的内容控件数量不是 1"
        return evidence
    control = controls[0]
    evidence["type"] = int(control.Type)
    evidence["tag"] = str(control.Tag)
    evidence["title"] = str(control.Title)
    evidence["inline_shape_count"] = int(control.Range.InlineShapes.Count)
    evidence["marker_count"] = len(find_literal_ranges(document, formula["marker"]))
    if control.Type != WD_CONTENT_CONTROL_RICH_TEXT:
        evidence["error"] = "重开后内容控件不是 Rich Text 类型"
        return evidence
    if control.Tag != tag or control.Title != tag:
        evidence["error"] = "重开后内容控件 Tag 或 Title 不符合预期"
        return evidence
    if evidence["marker_count"] != 0:
        evidence["error"] = "重开后原文本标记仍然存在"
        return evidence
    if control.Range.InlineShapes.Count != 1:
        evidence["error"] = "重开后内容控件内嵌对象数量不是 1"
        return evidence
    shape = control.Range.InlineShapes(1)
    object_ok, object_evidence = verify_shape(shape)
    evidence["object"] = object_evidence
    evidence["reopen_stable"] = object_ok
    if not object_ok:
        evidence["error"] = "重开后对象不再是有效的 Equation.DSMT4 内嵌 OLE"
        return evidence
    if formula["kind"] == "display":
        actual_space_after = safe_value(
            lambda: float(control.Range.Paragraphs(1).Range.ParagraphFormat.SpaceAfter)
        )
        compensation_persisted = bool(
            isinstance(actual_space_after, float)
            and isinstance(expected_space_after_pt, (int, float))
            and abs(actual_space_after - float(expected_space_after_pt)) <= 0.1
        )
        evidence["layout_compensation"] = {
            "expected_space_after_pt": expected_space_after_pt,
            "actual_space_after_pt": (
                round(actual_space_after, 3)
                if isinstance(actual_space_after, float)
                else None
            ),
            "persisted": compensation_persisted,
        }
        if not compensation_persisted:
            evidence["reopen_stable"] = False
            evidence["error"] = "重开后显示公式段后距补偿未稳定保留"
            return evidence
        layout = formula.get("preflight_display_layout")
        placement_mode = layout.get("placement_mode") if isinstance(layout, dict) else None
        if placement_mode not in ("marker-exclusive-paragraph", "numbered-formula-groups"):
            evidence["reopen_stable"] = False
            evidence["error"] = "重开后缺少显示公式宿主模式证据"
            return evidence
        host = verify_display_host(control, formula, str(placement_mode))
        evidence["display_host"] = host
        if not host["valid"]:
            evidence["reopen_stable"] = False
            evidence["error"] = "重开后普通文本公式编号未稳定保留"
    return evidence


def strip_math_delimiters(latex: str) -> str:
    """去除一层常见数学定界符，不改写公式主体。"""

    value = latex.strip()
    delimiter_pairs = ((r"\[", r"\]"), (r"\(", r"\)"), ("$$", "$$"), ("$", "$"))
    for opening, closing in delimiter_pairs:
        if value.startswith(opening) and value.endswith(closing):
            return value[len(opening) : len(value) - len(closing)].strip()
    return value


def normalize_latex_for_compare(latex: str) -> str:
    """执行保守的 TeX 规范化，避免把不同数学结构误判为等价。"""

    value = unicodedata.normalize("NFC", latex)
    value = value.replace("\r\n", "\n").replace("\r", "\n")
    value = strip_math_delimiters(value)
    return re.sub(r"[ \t\n]+", " ", value).strip()


def roundtrip_verify_formula(word: Any, document: Any, formula: dict[str, Any]) -> dict[str, Any]:
    """在临时副本中把 MathType OLE 反向转换为 TeX 并比较。"""

    expected = formula["expected_math_latex"]
    content: dict[str, Any] = {
        "expected_math_latex": expected,
        "roundtrip_tex": None,
        "semantic_equivalent": False,
    }
    tag = formula["content_control_name"]
    controls = content_controls_by_tag(document, tag)
    content["content_control_count_before_toggle"] = len(controls)
    if len(controls) != 1:
        content["error"] = f"临时副本中 Tag={tag} 的内容控件数量不是 1"
        return content

    control = controls[0]
    if control.Range.InlineShapes.Count != 1:
        content["error"] = "临时副本内容控件内嵌对象数量不是 1"
        return content
    shape = control.Range.InlineShapes(1)
    object_ok, _ = verify_shape(shape)
    if not object_ok:
        content["error"] = "临时副本中的对象不是有效的 Equation.DSMT4 内嵌 OLE"
        return content

    shape_range = shape.Range.Duplicate
    control.Delete(False)
    if shape_range.InlineShapes.Count != 1:
        content["error"] = "解除内容控件后无法唯一定位 MathType 对象"
        return content
    shape_range.InlineShapes(1).Range.Select()
    word.Run(MATHTYPE_MACRO)
    roundtrip_tex = str(word.Selection.Range.Text)
    expected_normalized = normalize_latex_for_compare(expected)
    roundtrip_normalized = normalize_latex_for_compare(roundtrip_tex)
    content.update(
        {
            "roundtrip_tex": roundtrip_tex,
            "expected_normalized": expected_normalized,
            "roundtrip_normalized": roundtrip_normalized,
            "semantic_equivalent": roundtrip_normalized == expected_normalized,
        }
    )
    if not content["semantic_equivalent"]:
        content["error"] = "MathType 回译 TeX 与清单公式不一致"
    return content


def safe_close_document(document: Any, report: dict[str, Any], context: str) -> bool:
    try:
        document.Close(SaveChanges=WD_DO_NOT_SAVE_CHANGES)
        return True
    except Exception as exc:
        report.setdefault("cleanup_errors", []).append(
            {"operation": "document.Close", "context": context, "error": str(exc)}
        )
        return False


def safe_quit_word(word: Any, report: dict[str, Any]) -> bool:
    try:
        word.Quit(SaveChanges=WD_DO_NOT_SAVE_CHANGES)
        return True
    except Exception as exc:
        report.setdefault("cleanup_errors", []).append(
            {"operation": "word.Quit", "error": str(exc)}
        )
        return False


def preflight_document(
    document: Any, formulas: list[dict[str, Any]]
) -> list[tuple[int, int, dict[str, Any]]]:
    errors: list[str] = []
    positioned: list[tuple[int, int, dict[str, Any]]] = []
    tag_counts = all_content_control_tags(document)
    for index, formula in enumerate(formulas):
        matches = find_literal_ranges(document, formula["marker"])
        if len(matches) != 1:
            errors.append(
                f"公式 {formula['formula_id']} 的标记必须恰好出现一次，实际为 {len(matches)} 次"
            )
            continue
        if tag_counts[formula["content_control_name"]] != 0:
            errors.append(f"公式 {formula['formula_id']} 的目标内容控件 Tag 已存在")
        target = matches[0]
        positioned.append((int(target.Start), index, formula))
        if formula["kind"] == "display":
            layout = inspect_display_marker_paragraph(target, formula)
            formula["preflight_display_layout"] = layout
            if not layout["valid"]:
                errors.append(
                    f"公式 {formula['formula_id']} 的显示槽位/编号门禁失败："
                    + "；".join(layout["errors"])
                )
    if errors:
        raise RuntimeError("；".join(errors))
    return positioned


def failed_formula_item(formula: dict[str, Any], error: str) -> dict[str, Any]:
    return {
        "formula_id": formula["formula_id"],
        "state": FAIL,
        "status": FAIL,
        "source_type": formula["source_type"],
        "attempt": {},
        "rollback": {},
        "anchor": {},
        "object": None,
        "kind": formula["kind"],
        "marker": formula["marker"],
        "tex_hash": formula["tex_hash"],
        "content_control_tag": formula["content_control_name"],
        "errors": [error],
        **formula_report_context(formula),
    }


def process_document(
    staging_docx: Path, formulas: list[dict[str, Any]], report: dict[str, Any]
) -> bool:
    """每条公式在临时副本转换、重开并回译；成功后才推进内部快照。"""

    import pythoncom
    import win32com.client

    coinitialized = False
    word = None
    document = None
    attempts_dir = staging_docx.parent / "formula-attempts"
    attempts_dir.mkdir(parents=False, exist_ok=False)
    try:
        pythoncom.CoInitialize()
        coinitialized = True
        word = win32com.client.DispatchEx("Word.Application")
        word.Visible = False
        word.DisplayAlerts = 0
        report["word_version"] = str(word.Version)
        report["word_build"] = str(word.Build)
        report["mathtype_template_loaded"] = mathtype_template_loaded(word)
        if not report["mathtype_template_loaded"]:
            raise RuntimeError("Word 未加载 MathType Commands 2016.dotm")

        document = word.Documents.Open(
            str(staging_docx),
            ConfirmConversions=False,
            ReadOnly=True,
            AddToRecentFiles=False,
            Visible=False,
            OpenAndRepair=False,
            NoEncodingDialog=True,
        )
        try:
            positioned = preflight_document(document, formulas)
        except Exception as exc:
            for formula in formulas:
                item = failed_formula_item(formula, f"批次预检失败：{exc}")
                item["attempt"] = {
                    "index": 0,
                    "phase": "preflight",
                    "saved": False,
                    "reopened": False,
                    "roundtrip_checked": False,
                    "committed": False,
                }
                item["rollback"] = {
                    "strategy": "no-mutation-before-preflight",
                    "performed": False,
                    "snapshot_unchanged": True,
                    "marker_preserved": True,
                }
                report["formulas"].append(item)
            report["insertion_order"] = []
            report["remaining_marker_count"] = len(formulas)
            safe_close_document(document, report, "preflight-failed")
            document = None
            return False
        if not safe_close_document(document, report, "preflight"):
            raise RuntimeError("预检文档关闭失败")
        document = None
        insertion_order = [
            formula
            for _, _, formula in sorted(
                positioned, key=lambda item: (item[0], item[1]), reverse=True
            )
        ]
        report["insertion_order"] = [formula["formula_id"] for formula in insertion_order]

        for attempt_index, formula in enumerate(insertion_order, start=1):
            snapshot_sha256 = file_sha256(staging_docx)
            attempt_docx = attempts_dir / f"attempt-{attempt_index:04d}.docx"
            roundtrip_docx = attempts_dir / f"roundtrip-{attempt_index:04d}.docx"
            shutil.copy2(staging_docx, attempt_docx)
            item: dict[str, Any] | None = None
            saved = False
            reopened = False
            roundtrip_checked = False
            committed = False
            try:
                document = word.Documents.Open(
                    str(attempt_docx),
                    ConfirmConversions=False,
                    ReadOnly=False,
                    AddToRecentFiles=False,
                    Visible=False,
                    OpenAndRepair=False,
                    NoEncodingDialog=True,
                )
                item = convert_formula(word, document, formula)
                if item.get("state") not in (PASS, REVIEW):
                    raise RuntimeError("MathType 插入门禁未通过")
                document.Save()
                saved = True
                if not safe_close_document(document, report, f"attempt-{attempt_index}-save"):
                    raise RuntimeError("公式尝试保存后关闭失败")
                document = None

                document = word.Documents.Open(
                    str(attempt_docx),
                    ConfirmConversions=False,
                    ReadOnly=True,
                    AddToRecentFiles=False,
                    Visible=False,
                    OpenAndRepair=False,
                    NoEncodingDialog=True,
                )
                reopened = True
                expected_space_after = safe_value(
                    lambda: float(
                        item["layout_compensation"]["target_space_after_pt"]
                    )
                )
                persistence = reopen_verify(
                    document, formula, expected_space_after
                )
                item["persistence"] = persistence
                item["cleanup"] = {
                    "marker_count": persistence.get("marker_count"),
                    "payload_count": persistence.get("inline_shape_count"),
                    "residual_fragment_count": None,
                }
                if not persistence["reopen_stable"]:
                    raise RuntimeError(persistence.get("error", "保存重开复核失败"))
                if not safe_close_document(document, report, f"attempt-{attempt_index}-verify"):
                    raise RuntimeError("公式尝试复核后关闭失败")
                document = None

                shutil.copy2(attempt_docx, roundtrip_docx)
                document = word.Documents.Open(
                    str(roundtrip_docx),
                    ConfirmConversions=False,
                    ReadOnly=False,
                    AddToRecentFiles=False,
                    Visible=False,
                    OpenAndRepair=False,
                    NoEncodingDialog=True,
                )
                content = roundtrip_verify_formula(word, document, formula)
                roundtrip_checked = True
                item["content"] = content
                if not content["semantic_equivalent"]:
                    raise RuntimeError(content.get("error", "MathType TeX 回译门禁失败"))
                if not safe_close_document(document, report, f"attempt-{attempt_index}-roundtrip"):
                    raise RuntimeError("MathType 回译副本关闭失败")
                document = None

                os.replace(attempt_docx, staging_docx)
                committed = True
            except Exception as exc:
                if item is None:
                    item = failed_formula_item(formula, str(exc))
                else:
                    set_public_state(item, FAIL)
                    if str(exc) not in item.setdefault("errors", []):
                        item["errors"].append(str(exc))
            finally:
                if document is not None:
                    safe_close_document(document, report, f"attempt-{attempt_index}-exception")
                    document = None
                for disposable in (attempt_docx, roundtrip_docx):
                    if disposable.exists():
                        try:
                            disposable.unlink()
                        except Exception as exc:
                            report.setdefault("cleanup_errors", []).append(
                                {
                                    "operation": "attempt.unlink",
                                    "context": disposable.name,
                                    "error": str(exc),
                                }
                            )
                snapshot_unchanged = bool(
                    not committed and file_sha256(staging_docx) == snapshot_sha256
                )
                item["attempt"] = {
                    "index": attempt_index,
                    "working_copy": attempt_docx.name,
                    "input_snapshot_sha256": snapshot_sha256,
                    "saved": saved,
                    "reopened": reopened,
                    "roundtrip_checked": roundtrip_checked,
                    "committed": committed,
                }
                item["rollback"] = {
                    "strategy": "discard-attempt-copy",
                    "performed": not committed,
                    "snapshot_unchanged": snapshot_unchanged,
                    "marker_preserved": snapshot_unchanged,
                }
                report["formulas"].append(item)

        by_id = {item["formula_id"]: item for item in report["formulas"]}
        report["formulas"] = [by_id[formula["formula_id"]] for formula in formulas]
        report["remaining_marker_count"] = sum(
            1 for item in report["formulas"] if item["state"] == FAIL
        )
        return all(item["state"] in (PASS, REVIEW) for item in report["formulas"])
    finally:
        if document is not None:
            safe_close_document(document, report, "outer-finally")
        if word is not None:
            safe_quit_word(word, report)
        if coinitialized:
            try:
                pythoncom.CoUninitialize()
            except Exception as exc:
                report.setdefault("cleanup_errors", []).append(
                    {"operation": "pythoncom.CoUninitialize", "error": str(exc)}
                )


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    with path.open("x", encoding="utf-8", newline="\n") as handle:
        handle.write(text)


def build_parser() -> argparse.ArgumentParser:
    parser = ChineseArgumentParser(
        description="按 DOCX 文本标记把 TeX 公式回填为 MathType OLE 对象",
        add_help=False,
        usage=(
            "%(prog)s [-h] [--allow-review-candidates] [--registry 公式注册表] "
            "[--evidence 证据路径] "
            "输入DOCX 公式清单 输出DOCX"
        ),
    )
    parser._positionals.title = "位置参数"
    parser._optionals.title = "选项"
    parser.add_argument(
        "input_docx",
        type=Path,
        metavar="输入DOCX",
        help="包含 [[formula_id]] 标记的基础 DOCX",
    )
    parser.add_argument("manifest", type=Path, metavar="公式清单", help="TeX 公式清单 JSON")
    parser.add_argument(
        "output_docx",
        type=Path,
        metavar="输出DOCX",
        help="输出 DOCX，必须尚不存在",
    )
    parser.add_argument(
        "--evidence",
        type=Path,
        metavar="证据路径",
        help="UTF-8 JSON 证据路径；默认使用输出文件名加 .mathtype-evidence.json",
    )
    parser.add_argument(
        "--registry",
        type=Path,
        metavar="公式注册表",
        help="统一公式注册表；提供后以 expected.payload_type/content_control_tag 为唯一依据",
    )
    parser.add_argument(
        "--allow-review-candidates",
        action="store_true",
        help=(
            "仅允许 status=REVIEW 且 final_mathtype_eligible=false 的 OCR 公式生成"
            "候选 DOCX；该运行永远不会产生最终 PASS"
        ),
    )
    parser.add_argument("-h", "--help", action="help", help="显示帮助信息并退出")
    return parser


def main() -> int:
    configure_stdio()
    args = build_parser().parse_args()
    input_docx = args.input_docx.expanduser().resolve()
    manifest_path = args.manifest.expanduser().resolve()
    registry_path = args.registry.expanduser().resolve() if args.registry else None
    output_docx = args.output_docx.expanduser().resolve()
    evidence_path = (
        args.evidence.expanduser().resolve()
        if args.evidence
        else output_docx.with_suffix(".mathtype-evidence.json")
    )
    started = time.perf_counter()
    report: dict[str, Any] = {
        "schema_version": "2.0",
        "started_at": utc_now(),
        "state": FAIL,
        "status": FAIL,
        "status_scope": "仅表示 MathType 插入、保存重开和 TeX 回译门禁，不代表版面总门禁",
        "input_docx": str(input_docx),
        "manifest": str(manifest_path),
        "registry": str(registry_path) if registry_path is not None else None,
        "registry_sha256": None,
        "output_docx": str(output_docx),
        "evidence": str(evidence_path),
        "macro": MATHTYPE_MACRO,
        "allow_review_candidates": args.allow_review_candidates,
        "formulas": [],
        "warnings": [],
        "errors": [],
        "transaction": {
            "strategy": "per-formula-copy-on-write",
            "published": False,
            "atomic_publish": False,
        },
    }

    can_write_evidence = not evidence_path.exists()
    try:
        if platform.system() != "Windows":
            raise RuntimeError("MathType 回填仅支持 Windows")
        if importlib.util.find_spec("win32com.client") is None:
            raise RuntimeError("当前 Python 环境未安装 pywin32")
        if not input_docx.is_file():
            raise FileNotFoundError(f"输入 DOCX 不存在：{input_docx}")
        if input_docx.suffix.lower() != ".docx":
            raise ValueError("输入文件扩展名必须为 .docx")
        if not manifest_path.is_file():
            raise FileNotFoundError(f"公式清单不存在：{manifest_path}")
        if registry_path is not None and not registry_path.is_file():
            raise FileNotFoundError(f"统一公式注册表不存在：{registry_path}")
        if output_docx.suffix.lower() != ".docx":
            raise ValueError("输出文件扩展名必须为 .docx")
        if input_docx == output_docx:
            raise ValueError("输入和输出 DOCX 路径不能相同")
        if output_docx.exists():
            raise FileExistsError(f"拒绝覆盖已有输出文件：{output_docx}")
        if evidence_path.exists():
            raise FileExistsError(f"拒绝覆盖已有证据文件：{evidence_path}")
        protected_paths = {input_docx, manifest_path, output_docx}
        if registry_path is not None:
            protected_paths.add(registry_path)
        if evidence_path in protected_paths:
            raise ValueError("证据路径不能与输入、清单或输出 DOCX 相同")

        manifest_payload = load_json(manifest_path)
        if registry_path is not None:
            registry_payload = load_json(registry_path)
            formulas, manifest_safety = normalize_registry_mathtype(
                registry_payload,
                allow_review_candidates=args.allow_review_candidates,
            )
            report["registry_sha256"] = file_sha256(registry_path)
            report["registry_binding"] = {
                "path": str(registry_path),
                "sha256": report["registry_sha256"],
                "authoritative_fields": [
                    "expected.payload_type",
                    "expected.content_control_tag",
                ],
            }
        else:
            formulas = normalize_manifest(
                manifest_payload,
                allow_review_candidates=args.allow_review_candidates,
            )
            manifest_safety = inspect_manifest_safety(manifest_payload, formulas)
        report["manifest_safety"] = manifest_safety
        if manifest_safety["review_candidate_formula_ids"]:
            report["warnings"].append(
                "已按显式候选模式插入非最终合格的 OCR REVIEW 公式；输出只能作为候选版"
            )
        if manifest_safety["final_pass_blocked"]:
            report["warnings"].append(
                "OCR 清单尚未满足最终全量资格；必须完成图片回退与总门禁后才能交付最终稿"
            )
        report["formula_count"] = len(formulas)
        report["input_sha256"] = file_sha256(input_docx)
        report["manifest_sha256"] = file_sha256(manifest_path)
        output_docx.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(
            prefix=".pdf2word-mathtype-transaction-", dir=output_docx.parent
        ) as transaction_dir:
            staging_docx = Path(transaction_dir) / "committed.docx"
            shutil.copy2(input_docx, staging_docx)
            if formulas:
                transaction_ok = process_document(staging_docx, formulas, report)
            else:
                transaction_ok = True
                report["insertion_order"] = []
                report["remaining_marker_count"] = 0
            states = [item["state"] for item in report["formulas"]]
            report["summary"] = {
                state: states.count(state)
                for state in (PASS, REVIEW, FALLBACK, FAIL)
            }
            if not transaction_ok:
                raise RuntimeError("至少一个 MathType 公式回填失败，正式输出未发布")
            os.replace(staging_docx, output_docx)
            report["transaction"].update(
                {"published": True, "atomic_publish": True}
            )

        final_review = bool(
            report["manifest_safety"]["final_pass_blocked"]
            or any(item["state"] == REVIEW for item in report["formulas"])
        )
        set_public_state(report, REVIEW if final_review else PASS)
        report["output_size_bytes"] = output_docx.stat().st_size
        report["output_sha256"] = file_sha256(output_docx)
    except Exception as exc:
        report["errors"].append(str(exc))
        set_public_state(report, FAIL)
        if output_docx.exists():
            report["warnings"].append("原子发布后发生异常；输出必须按 FAIL 处理")
            report["output_size_bytes"] = output_docx.stat().st_size
            report["output_sha256"] = file_sha256(output_docx)
    finally:
        report["finished_at"] = utc_now()
        report["duration_seconds"] = round(time.perf_counter() - started, 3)
        if can_write_evidence:
            try:
                write_json(evidence_path, report)
            except Exception as exc:
                print(f"错误：无法写入证据文件：{exc}", file=sys.stderr)
                return 1
        else:
            print(json.dumps(report, ensure_ascii=False, indent=2), file=sys.stderr)

    if report["state"] == PASS:
        return 0
    return 2 if report["state"] in (REVIEW, FALLBACK) else 1


if __name__ == "__main__":
    sys.exit(main())
