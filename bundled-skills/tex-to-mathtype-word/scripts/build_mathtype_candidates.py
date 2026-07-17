#!/usr/bin/env python3
"""为 MathType 公式工厂生成可追踪的 LaTeX 兼容候选。"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


PASS = "PASS"
REVIEW = "REVIEW"
FALLBACK = "FALLBACK"
FAIL = "FAIL"
VALID_STATES = (PASS, REVIEW, FALLBACK, FAIL)
FORMULA_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
BEGIN_ENV_RE = re.compile(r"\\begin\{([^{}]+)\}")
ALIGNED_BEGIN_RE = re.compile(r"\\begin\{aligned\}(?:\{[^{}]*\})?")
ARRAY_BEGIN_RE = re.compile(r"\\begin\{array\}\{[^{}]*\}")
LAYOUT_COMMAND_RE = re.compile(
    r"\\(?:left|right|big(?:l|r)?|Big(?:l|r)?|bigg(?:l|r)?|Bigg(?:l|r)?|"
    r"qquad|quad|enspace|thinspace|medspace|thickspace)\b"
)
MKERN_RE = re.compile(r"\\mkern\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)mu\b")
SYMBOLIC_SPACE_RE = re.compile(r"\\[!,:;]")


class ChineseArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        self.print_usage(sys.stderr)
        self.exit(2, f"错误：{message}\n")


def configure_stdio() -> None:
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            reconfigure(encoding="utf-8", errors="replace")


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def text_sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_json(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(payload, dict):
        raise ValueError("公式清单根节点必须是对象")
    return payload


def write_json_exclusive(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x", encoding="utf-8", newline="\n") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.write("\n")


def strip_math_delimiters(value: str) -> str:
    latex = value.strip()
    pairs = (("$$", "$$"), ("$", "$"), ("\\[", "\\]"), ("\\(", "\\)"))
    for opening, closing in pairs:
        if latex.startswith(opening) and latex.endswith(closing):
            return latex[len(opening) : -len(closing)].strip()
    equation = re.fullmatch(
        r"\\begin\{(?:equation\*?|displaymath)\}([\s\S]*)"
        r"\\end\{(?:equation\*?|displaymath)\}",
        latex,
    )
    return equation.group(1).strip() if equation else latex


def latex_from_formula(item: dict[str, Any]) -> str:
    source = item.get("source") if isinstance(item.get("source"), dict) else {}
    for key in ("math_latex", "body_latex", "latex"):
        value = item.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    value = source.get("latex")
    if isinstance(value, str) and value.strip():
        return value.strip()
    raise ValueError(f"公式 {item.get('formula_id', '<unknown>')} 缺少 LaTeX")


def declared_latex_hashes(item: dict[str, Any]) -> set[str]:
    source = item.get("source") if isinstance(item.get("source"), dict) else {}
    hashes: set[str] = set()
    for owner in (item, source):
        for key in ("latex_hash", "tex_hash", "math_tex_hash"):
            value = owner.get(key)
            if isinstance(value, str) and re.fullmatch(r"[0-9a-fA-F]{64}", value):
                hashes.add(value.lower())
    return hashes


def review_allows_retry(item: dict[str, Any]) -> bool:
    source_type = str(item.get("source_type", item.get("source", {}).get("type", ""))).lower()
    if source_type == "tex":
        return True
    review = item.get("independent_review")
    if not isinstance(review, dict):
        source = item.get("source") if isinstance(item.get("source"), dict) else {}
        review = source.get("independent_review")
    if not isinstance(review, dict):
        return False
    confidence = review.get("confidence")
    return bool(
        review.get("status") == PASS
        and isinstance(confidence, (int, float))
        and not isinstance(confidence, bool)
        and float(confidence) >= 0.95
        and review.get("source_visual_match") is True
        and review.get("critical_symbols_ok") is True
        and review.get("ambiguities_resolved") is True
    )


def remove_unescaped_alignment_marks(value: str) -> str:
    output: list[str] = []
    for index, character in enumerate(value):
        if character != "&":
            output.append(character)
            continue
        backslashes = 0
        cursor = index - 1
        while cursor >= 0 and value[cursor] == "\\":
            backslashes += 1
            cursor -= 1
        if backslashes % 2:
            output.append(character)
    return "".join(output)


def aligned_to_array(value: str) -> str | None:
    if not ALIGNED_BEGIN_RE.search(value) or r"\end{aligned}" not in value:
        return None
    transformed = ALIGNED_BEGIN_RE.sub(r"\\begin{array}{l}", value)
    transformed = transformed.replace(r"\end{aligned}", r"\end{array}")
    return remove_unescaped_alignment_marks(transformed)


def flatten_aligned(value: str) -> str | None:
    if not ALIGNED_BEGIN_RE.search(value) or r"\end{aligned}" not in value:
        return None
    transformed = ALIGNED_BEGIN_RE.sub("", value)
    transformed = transformed.replace(r"\end{aligned}", "")
    transformed = remove_unescaped_alignment_marks(transformed)
    transformed = transformed.replace(r"\\", " ")
    return re.sub(r"\s+", " ", transformed).strip()


def minimize_layout(value: str) -> str | None:
    """删除 TeX 排版提示，保留公式的数学 token 与运算顺序。"""

    transformed = value
    while ALIGNED_BEGIN_RE.search(transformed) and r"\end{aligned}" in transformed:
        transformed = ALIGNED_BEGIN_RE.sub("", transformed)
        transformed = transformed.replace(r"\end{aligned}", "")
    transformed = remove_unescaped_alignment_marks(transformed)
    transformed = transformed.replace(r"\\", "")
    transformed = LAYOUT_COMMAND_RE.sub("", transformed)
    transformed = MKERN_RE.sub("", transformed)
    transformed = SYMBOLIC_SPACE_RE.sub("", transformed)
    transformed = transformed.replace("{}", "")
    transformed = re.sub(r"\s+", "", transformed)
    return transformed if transformed and transformed != value else None


def portable_command_variant(value: str) -> str | None:
    replacements = {r"\dfrac": r"\frac", r"\tfrac": r"\frac"}
    transformed = value
    steps = 0
    for source, target in replacements.items():
        if source in transformed:
            transformed = transformed.replace(source, target)
            steps += 1
    return transformed if steps and transformed != value else None


def force_math_variant(value: str) -> str | None:
    if re.fullmatch(r"[A-Za-z0-9.,]+", value):
        return rf"\mathord{{{value}}}"
    return None


def normalize_semantic_tokens(value: str) -> str:
    """仅折叠本脚本允许改变的排版结构，保留数学 token。"""

    normalized = strip_math_delimiters(value)
    normalized = re.sub(r"\\mathord\{([^{}]*)\}", r"\1", normalized)
    normalized = ALIGNED_BEGIN_RE.sub("", normalized)
    normalized = normalized.replace(r"\end{aligned}", "")
    normalized = ARRAY_BEGIN_RE.sub("", normalized)
    normalized = normalized.replace(r"\end{array}", "")
    normalized = remove_unescaped_alignment_marks(normalized)
    normalized = normalized.replace(r"\\", "")
    normalized = LAYOUT_COMMAND_RE.sub("", normalized)
    normalized = MKERN_RE.sub("", normalized)
    normalized = SYMBOLIC_SPACE_RE.sub("", normalized)
    normalized = normalized.replace("{}", "")
    normalized = normalized.replace(r"\dfrac", r"\frac")
    normalized = normalized.replace(r"\tfrac", r"\frac")
    normalized = normalized.replace(r"\displaystyle", "")
    return re.sub(r"\s+", "", normalized)


def semantic_fingerprint(value: str) -> str:
    return text_sha256(normalize_semantic_tokens(value))


def complexity_profile(latex: str) -> dict[str, Any]:
    environments = BEGIN_ENV_RE.findall(latex)
    line_break_count = latex.count(r"\\")
    brace_depth = 0
    maximum_brace_depth = 0
    escaped = False
    for character in latex:
        if escaped:
            escaped = False
            continue
        if character == "\\":
            escaped = True
        elif character == "{":
            brace_depth += 1
            maximum_brace_depth = max(maximum_brace_depth, brace_depth)
        elif character == "}":
            brace_depth = max(0, brace_depth - 1)
    length = len(latex)
    if length >= 900 or any(env in {"aligned", "alignedat"} for env in environments):
        risk = "very-high" if length >= 900 else "high"
    elif length >= 512 or line_break_count >= 2 or environments:
        risk = "high"
    elif length >= 220 or maximum_brace_depth >= 6:
        risk = "medium"
    else:
        risk = "low"
    return {
        "latex_length": length,
        "line_break_count": line_break_count,
        "environments": environments,
        "maximum_brace_depth": maximum_brace_depth,
        "has_left_right": r"\left" in latex or r"\right" in latex,
        "risk": risk,
    }


def build_candidates(canonical_latex: str) -> list[dict[str, Any]]:
    variants: list[tuple[str, str, list[str]]] = [
        ("canonical", canonical_latex, ["保留规范 LaTeX，不做转换"])
    ]
    minimized = minimize_layout(canonical_latex)
    if minimized:
        variants.append(
            (
                "layout-minimized",
                minimized,
                [
                    "移除 aligned 环境、对齐符和显式换行",
                    "移除伸缩定界符与纯间距命令",
                    "移除空组和无意义空白",
                ],
            )
        )
    array_variant = aligned_to_array(canonical_latex)
    if array_variant:
        variants.append(
            (
                "aligned-to-array",
                array_variant,
                ["将 aligned 环境转换为单列 array", "删除仅用于对齐的未转义 &"],
            )
        )
    flat_variant = flatten_aligned(canonical_latex)
    if flat_variant:
        variants.append(
            (
                "flatten-aligned",
                flat_variant,
                ["移除 aligned 环境", "移除对齐符并把显式换行转换为空格"],
            )
        )
    portable = portable_command_variant(canonical_latex)
    if portable:
        variants.append(
            (
                "portable-fractions",
                portable,
                ["将 dfrac/tfrac 规范为 frac"],
            )
        )
    forced = force_math_variant(canonical_latex)
    if forced:
        variants.append(
            (
                "force-math",
                forced,
                ["使用语义透明的 mathord 包装，强制 MathType 按数学表达式解析"],
            )
        )
    seen: set[str] = set()
    result: list[dict[str, Any]] = []
    canonical_semantic_hash = semantic_fingerprint(canonical_latex)
    for candidate_id, latex, steps in variants:
        normalized = latex.strip()
        digest = text_sha256(normalized)
        if digest in seen:
            continue
        candidate_semantic_hash = semantic_fingerprint(normalized)
        if candidate_semantic_hash != canonical_semantic_hash:
            continue
        seen.add(digest)
        result.append(
            {
                "candidate_id": candidate_id,
                "latex": normalized,
                "latex_hash": digest,
                "transform_steps": steps,
                "requires_roundtrip_gate": True,
                "canonical_semantic_hash": canonical_semantic_hash,
                "candidate_semantic_hash": candidate_semantic_hash,
                "semantic_transform_verified": True,
            }
        )
    return result


def normalize_formula(item: dict[str, Any], origin: str) -> dict[str, Any]:
    formula_id = item.get("formula_id")
    if not isinstance(formula_id, str) or not FORMULA_ID_RE.fullmatch(formula_id):
        raise ValueError("公式清单包含无效 formula_id")
    raw_latex = latex_from_formula(item)
    canonical_latex = strip_math_delimiters(raw_latex)
    raw_hash = text_sha256(raw_latex)
    canonical_hash = text_sha256(canonical_latex)
    declared = declared_latex_hashes(item)
    if declared and not ({raw_hash, canonical_hash} & declared):
        raise ValueError(f"公式 {formula_id} 的 LaTeX 哈希与内容不一致")
    return {
        "formula_id": formula_id,
        "kind": item.get("kind", "display"),
        "source_type": item.get("source_type", item.get("source", {}).get("type")),
        "source_status": item.get("status", item.get("state")),
        "source_collection": origin,
        "fallback_allowed": item.get("fallback_allowed", False),
        "canonical_latex": canonical_latex,
        "canonical_latex_hash": canonical_hash,
        "canonical_semantic_hash": semantic_fingerprint(canonical_latex),
        "raw_latex_hash": raw_hash,
        "declared_latex_hashes": sorted(declared),
        "complexity": complexity_profile(canonical_latex),
        "candidates": build_candidates(canonical_latex),
        "source_formula": item,
    }


def select_source_items(
    payload: dict[str, Any], retry_rejected: bool, selected_ids: list[str]
) -> list[tuple[dict[str, Any], str]]:
    formulas = payload.get("formulas")
    if not isinstance(formulas, list):
        raise ValueError("公式清单缺少 formulas 数组")
    items: list[tuple[dict[str, Any], str]] = [
        (item, "formulas") for item in formulas if isinstance(item, dict)
    ]
    if retry_rejected:
        rejected = payload.get("rejected_formulas", [])
        if not isinstance(rejected, list):
            raise ValueError("rejected_formulas 必须是数组")
        items.extend((item, "rejected_formulas") for item in rejected if isinstance(item, dict))
    seen: set[str] = set()
    result: list[tuple[dict[str, Any], str]] = []
    selected = set(selected_ids)
    for item, origin in items:
        formula_id = item.get("formula_id")
        if selected and formula_id not in selected:
            continue
        if not isinstance(formula_id, str) or formula_id in seen:
            raise ValueError(f"公式 ID 无效或重复：{formula_id}")
        seen.add(formula_id)
        if origin == "formulas":
            source_state = str(item.get("state", item.get("status", ""))).upper()
            if source_state != PASS or item.get("final_mathtype_eligible") is not True:
                raise ValueError(
                    f"公式 {formula_id} 尚未取得来源 PASS 和 final_mathtype_eligible=true，"
                    "禁止生成正式 MathType 候选"
                )
        if origin == "rejected_formulas" and not review_allows_retry(item):
            raise ValueError(f"公式 {formula_id} 的来源内容未通过独立复核，禁止重试 MathType")
        result.append((item, origin))
    missing = selected - seen
    if missing:
        raise ValueError("找不到指定公式：" + "、".join(sorted(missing)))
    if not result:
        raise ValueError("没有可生成 MathType 候选的公式")
    return result


def build_report(
    input_path: Path,
    payload: dict[str, Any],
    retry_rejected: bool,
    selected_ids: list[str],
) -> dict[str, Any]:
    source_items = select_source_items(payload, retry_rejected, selected_ids)
    formulas = [normalize_formula(item, origin) for item, origin in source_items]
    risks = Counter(item["complexity"]["risk"] for item in formulas)
    return {
        "schema_version": "1.0",
        "stage": "build-mathtype-candidates",
        "generated_at": utc_now(),
        "status": PASS,
        "state": PASS,
        "source_manifest": {
            "path": str(input_path),
            "sha256": file_sha256(input_path),
        },
        "retry_rejected": retry_rejected,
        "selected_formula_ids": [item["formula_id"] for item in formulas],
        "formula_count": len(formulas),
        "candidate_count": sum(len(item["candidates"]) for item in formulas),
        "complexity_summary": dict(sorted(risks.items())),
        "formulas": formulas,
        "errors": [],
    }


def build_parser() -> argparse.ArgumentParser:
    parser = ChineseArgumentParser(
        description="生成带复杂度画像和 MathType 兼容变体的 LaTeX 候选清单",
        add_help=False,
    )
    parser._positionals.title = "位置参数"
    parser._optionals.title = "选项"
    parser.add_argument("input_manifest", type=Path, metavar="公式清单JSON")
    parser.add_argument("output", type=Path, metavar="候选清单JSON")
    parser.add_argument(
        "--formula-id", action="append", default=[], help="仅处理指定公式 ID；可重复"
    )
    parser.add_argument(
        "--retry-rejected",
        action="store_true",
        help="重新尝试此前仅因 MathType 探测失败而降级的独立复核公式",
    )
    parser.add_argument("-h", "--help", action="help", help="显示帮助信息并退出")
    return parser


def main() -> int:
    configure_stdio()
    args = build_parser().parse_args()
    input_path = args.input_manifest.expanduser().resolve()
    output_path = args.output.expanduser().resolve()
    if not input_path.is_file():
        print(f"错误：公式清单不存在：{input_path}", file=sys.stderr)
        return 1
    if input_path == output_path:
        print("错误：输入和输出路径必须不同", file=sys.stderr)
        return 1
    if output_path.exists():
        print(f"错误：拒绝覆盖已有输出：{output_path}", file=sys.stderr)
        return 1
    try:
        payload = load_json(input_path)
        report = build_report(
            input_path, payload, bool(args.retry_rejected), list(args.formula_id)
        )
        write_json_exclusive(output_path, report)
    except Exception as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return 1
    print(
        f"已生成 MathType 候选清单：{report['formula_count']} 条公式，"
        f"{report['candidate_count']} 个候选"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
