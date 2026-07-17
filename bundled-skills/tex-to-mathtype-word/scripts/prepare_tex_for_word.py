#!/usr/bin/env python3
"""提取 LaTeX 公式，并生成不让 Pandoc 创建 OMML 的占位源文件。"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path


DISPLAY_ENVIRONMENTS = ("equation", "align", "gather", "multline", "flalign")
DISPLAY_RE = re.compile(
    r"\\begin\{(?P<env>(?:" + "|".join(DISPLAY_ENVIRONMENTS) + r")\*?)\}"
    r"(?P<body>.*?)\\end\{(?P=env)\}",
    re.DOTALL,
)
BRACKET_DISPLAY_RE = re.compile(r"\\\[(?P<body>.*?)\\\]", re.DOTALL)
LABEL_RE = re.compile(r"\\label\{([^{}]+)\}")
METADATA_KEYS = (
    "collegename",
    "majorname",
    "studentname",
    "studentid",
    "researchdir",
    "supervisor",
    "thesistitle",
)
FRONT_MATTER_RE = re.compile(
    r"\\maketitlepage\s*"
    r"(?:\\pagenumbering\{(?:Roman|roman)\}\s*)?"
    r"\\tableofcontents\s*"
    r"(?:\\(?:newpage|clearpage)\s*)?"
    r"(?:\\pagenumbering\{arabic\}\s*)?",
    re.DOTALL,
)
PAGE_BREAK_RE = re.compile(r"\\(?:newpage|clearpage)\b")
PAGENUMBERING_RE = re.compile(r"\\pagenumbering\{[^{}]+\}")
PARAGRAPH_LAYOUT_OVERRIDE_RE = re.compile(r"\\renewcommand\s*\\paragraph\b")
RAISEBOX_IMAGE_RE = re.compile(
    r"\\raisebox\s*\{[^{}]*\}\s*"
    r"\{(\\includegraphics(?:\[[^\]]*\])?\{[^{}]+\})\}"
)


def active_mask(source: str) -> list[bool]:
    active = [True] * len(source)
    index = 0
    while index < len(source):
        if source[index] == "%" and (index == 0 or source[index - 1] != "\\"):
            end = source.find("\n", index)
            end = len(source) if end < 0 else end
            for pos in range(index, end):
                active[pos] = False
            index = end
        else:
            index += 1
    conditional = re.compile(r"\\(?:iffalse|iftrue|fi)\b")
    stack: list[bool] = []
    enabled = True
    cursor = 0
    for match in conditional.finditer(source):
        if not active[match.start()]:
            continue
        if not enabled:
            for pos in range(cursor, match.start()):
                active[pos] = False
        token = match.group(0)
        if token == "\\iffalse":
            stack.append(enabled)
            enabled = False
        elif token == "\\iftrue":
            stack.append(enabled)
        elif stack:
            enabled = stack.pop()
        cursor = match.end()
    if not enabled:
        for pos in range(cursor, len(source)):
            active[pos] = False
    return active


def strip_formula_controls(value: str) -> tuple[str, str | None]:
    labels = LABEL_RE.findall(value)
    value = LABEL_RE.sub("", value)
    value = re.sub(r"\\(?:notag|nonumber)\b", "", value)
    value = re.sub(r"\\tag\*?\{[^{}]*\}", "", value)
    return value.strip(), labels[0] if labels else None


def placeholder(index: int) -> str:
    return f"CIRCLETEXMATH{index:06d}"


def equation_token(index: int) -> str:
    return f"CIRCLETEXEQNUM{index:06d}"


def page_break_token(index: int) -> str:
    return f"CIRCLETEXPAGEBREAK{index:06d}"


GREEK_TEXT = {
    "alpha": "α", "beta": "β", "gamma": "γ", "delta": "δ", "epsilon": "ε",
    "theta": "θ", "kappa": "κ", "lambda": "λ", "mu": "μ", "nu": "ν", "xi": "ξ",
    "pi": "π", "rho": "ρ", "sigma": "σ", "tau": "τ", "phi": "φ",
    "eta": "η", "chi": "χ", "psi": "ψ", "omega": "ω", "Gamma": "Γ", "Delta": "Δ",
    "Theta": "Θ", "Lambda": "Λ", "Xi": "Ξ", "Pi": "Π", "Sigma": "Σ",
    "Phi": "Φ", "Psi": "Ψ", "Omega": "Ω",
}
TEXT_STYLE_COMMANDS = {"mathrm": "regular", "mathbf": "bold", "mathit": "italic", "textit": "italic"}
STRUCTURAL_COMMAND_RE = re.compile(
    r"\\(?:frac|dfrac|tfrac|sqrt|int|iint|iiint|sum|prod|lim|log|sin|cos|tan|"
    r"left|right|overline|underline|hat|widehat|bar|vec|begin|end|cases|operatorname)(?![A-Za-z])"
)
RELATION_OR_OPERATOR_RE = re.compile(
    r"(?:[=+*/]|(?<!^)-(?!$)|\\(?:cdot|times|div|pm|mp|leq|geq|neq|approx|sim|"
    r"to|rightarrow|leftarrow|in|notin|subseteq|cup|cap)(?![A-Za-z]))"
)
SIMPLE_NUMBER_RE = re.compile(r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?%?")
SIMPLE_LATIN_RE = re.compile(r"[A-Za-z]")
SIMPLE_STYLE_RE = re.compile(r"\\(mathrm|mathbf|mathit|textit)\{([A-Za-z0-9 ./%-]+)\}")
SIMPLE_TEXT_RE = re.compile(r"\\text\{([^{}]*)\}")
SIMPLE_BOLD_GREEK_RE = re.compile(r"\\boldsymbol\{\\([A-Za-z]+)\}")
SIMPLE_SYMBOL_TEXT = {r"\times": "×", r"\pm": "±", r"\mp": "∓"}
SIMPLE_INDEX_TEXT_RE = re.compile(r"[A-Za-z](?:,[A-Za-z])+")
SIMPLE_PAREN_NUMBER_RE = re.compile(r"\(\d+\)")
SIMPLE_DIMENSION_RE = re.compile(r"\d+(?:\s*\\times\s*\d+)+")
SIMPLE_COMMA_PREFIX_RE = re.compile(r",[A-Za-z]")
FUNCTION_CALL_RE = re.compile(r"(?:[A-Za-z]|\\(?:mathbf|mathrm|boldsymbol)\{[^{}]+\})\(")
SIMPLE_GREEK_LATIN_RE = re.compile(r"\\([A-Za-z]+)\s+[A-Za-z]")


def classify_math_segment(latex: str) -> tuple[str, str | None, str | None, str]:
    """仅在可证明存在二维数学结构时才交给 MathType。"""

    value = latex.strip()
    if SIMPLE_NUMBER_RE.fullmatch(value):
        return "word-text", value, "regular", "numeric-scalar"
    if SIMPLE_LATIN_RE.fullmatch(value):
        return "word-text", value, "italic", "single-latin-symbol"
    if value.startswith("\\") and value[1:] in GREEK_TEXT:
        return "word-text", GREEK_TEXT[value[1:]], "italic", "single-greek-symbol"
    bold_greek = SIMPLE_BOLD_GREEK_RE.fullmatch(value)
    if bold_greek and bold_greek.group(1) in GREEK_TEXT:
        return "word-text", GREEK_TEXT[bold_greek.group(1)], "bold", "single-greek-symbol"
    if value in SIMPLE_SYMBOL_TEXT:
        return "word-text", SIMPLE_SYMBOL_TEXT[value], "regular", "single-math-symbol"
    simple_style = SIMPLE_STYLE_RE.fullmatch(value)
    if simple_style:
        command, content = simple_style.groups()
        return "word-text", content, TEXT_STYLE_COMMANDS[command], "text-style-token"
    simple_text = SIMPLE_TEXT_RE.fullmatch(value)
    if simple_text:
        return "word-text", simple_text.group(1), "regular", "text-token"
    if SIMPLE_INDEX_TEXT_RE.fullmatch(value):
        return "word-text", value, "italic", "index-text-token"
    if SIMPLE_COMMA_PREFIX_RE.fullmatch(value):
        return "word-text", value, "italic", "index-text-token"
    greek_latin = SIMPLE_GREEK_LATIN_RE.fullmatch(value)
    if greek_latin and greek_latin.group(1) in GREEK_TEXT:
        return "word-text", f"{GREEK_TEXT[greek_latin.group(1)]} {value[-1]}", "italic", "adjacent-symbol-token"
    if SIMPLE_PAREN_NUMBER_RE.fullmatch(value):
        return "word-text", value, "regular", "parenthesized-number"
    dimension = SIMPLE_DIMENSION_RE.fullmatch(value)
    if dimension:
        return "word-text", re.sub(r"\s*\\times\s*", " × ", value), "regular", "dimension-text-token"
    if STRUCTURAL_COMMAND_RE.search(value) or "_" in value or "^" in value or FUNCTION_CALL_RE.search(value):
        return "mathtype", None, None, "structured-equation"
    if RELATION_OR_OPERATOR_RE.search(value):
        return "mathtype", None, None, "structured-equation"
    # 多字符正体单位或缩写不需要二维公式布局；未知宏则不能静默猜测。
    if re.fullmatch(r"[A-Za-z0-9 ./%-]+", value):
        return "word-text", value, "regular", "plain-text-token"
    return "review", None, None, "unclassified-math"


def classify_formulas(formulas: list[dict[str, object]]) -> None:
    for formula in formulas:
        target, text, style, classification = classify_math_segment(str(formula["latex"]))
        formula["renderTarget"] = target
        formula["classification"] = classification
        if text is not None:
            formula["wordText"] = text
            formula["wordTextStyle"] = style


def collect_display(source: str, mask: list[bool]) -> list[dict[str, object]]:
    matches: list[tuple[int, int, str, bool]] = []
    for regex in (DISPLAY_RE, BRACKET_DISPLAY_RE):
        for match in regex.finditer(source):
            if not mask[match.start()]:
                continue
            numbered = regex is DISPLAY_RE and not match.group("env").endswith("*")
            matches.append((match.start(), match.end(), match.group("body"), numbered))
    matches.sort(key=lambda item: item[0])
    results: list[dict[str, object]] = []
    equation_number = 0
    for start, end, body, numbered in matches:
        if any(start < int(item["end"]) for item in results):
            continue
        clean, label = strip_formula_controls(body)
        if numbered:
            equation_number += 1
        results.append({
            "start": start,
            "end": end,
            "latex": clean,
            "kind": "display",
            "number": str(equation_number) if numbered else None,
            "label": label,
        })
    return results


def collect_inline(source: str, mask: list[bool], occupied: list[dict[str, object]]) -> list[dict[str, object]]:
    results: list[dict[str, object]] = []
    index = 0
    while index < len(source):
        if not mask[index] or source[index] != "$" or (index > 0 and source[index - 1] == "\\"):
            index += 1
            continue
        if index + 1 < len(source) and source[index + 1] == "$":
            raise ValueError(f"第 {source.count(chr(10), 0, index) + 1} 行存在不支持的 $$ 公式。")
        if any(int(item["start"]) <= index < int(item["end"]) for item in occupied):
            index += 1
            continue
        end = index + 1
        while end < len(source):
            if source[end] == "$" and source[end - 1] != "\\" and mask[end]:
                break
            if source[end] == "\n":
                raise ValueError(f"第 {source.count(chr(10), 0, index) + 1} 行的行内公式未闭合。")
            end += 1
        if end >= len(source):
            raise ValueError(f"第 {source.count(chr(10), 0, index) + 1} 行的行内公式未闭合。")
        results.append({
            "start": index,
            "end": end + 1,
            "latex": source[index + 1:end].strip(),
            "kind": "inline",
            "number": None,
            "label": None,
        })
        index = end + 1
    return results


def apply_replacements(source: str, formulas: list[dict[str, object]]) -> str:
    output = source
    for formula in reversed(formulas):
        marker = str(formula["placeholder"])
        if formula["kind"] == "display":
            suffix = f" {formula['equationToken']}" if formula.get("equationToken") else ""
            marker = f"\n\n{marker}{suffix}\n\n"
        output = output[: int(formula["start"])] + marker + output[int(formula["end"]):]
    return output


def remove_inactive_conditionals(source: str) -> str:
    pattern = re.compile(r"\\iffalse\b.*?\\fi\b", re.DOTALL)
    previous = None
    while previous != source:
        previous = source
        source = pattern.sub("", source)
    return re.sub(r"\\iftrue\b(.*?)\\fi\b", r"\1", source, flags=re.DOTALL)


def replace_active_pattern(
    source: str,
    pattern: re.Pattern[str],
    replacement: str,
) -> str:
    mask = active_mask(source)
    matches = [match for match in pattern.finditer(source) if mask[match.start()]]
    for match in reversed(matches):
        source = source[: match.start()] + match.expand(replacement) + source[match.end():]
    return source


def replace_page_breaks(source: str) -> tuple[str, list[str]]:
    mask = active_mask(source)
    matches = [match for match in PAGE_BREAK_RE.finditer(source) if mask[match.start()]]
    tokens: list[str] = []
    for index, match in reversed(list(enumerate(matches, 1))):
        token = page_break_token(index)
        tokens.append(token)
        source = source[: match.start()] + f"\n\n{token}\n\n" + source[match.end():]
    tokens.reverse()
    return source, tokens


def count_active(source: str, pattern: re.Pattern[str]) -> int:
    mask = active_mask(source)
    return sum(mask[match.start()] for match in pattern.finditer(source))


def extract_structure(source: str) -> dict[str, object]:
    full_source = source
    document_start = source.find(r"\begin{document}")
    if document_start >= 0:
        source = source[document_start + len(r"\begin{document}"):]
    mask = active_mask(source)

    def has(pattern: str, flags: int = 0) -> bool:
        return any(mask[match.start()] for match in re.finditer(pattern, source, flags))

    document_class = ""
    class_match = re.search(r"\\documentclass(?:\[[^\]]*\])?\{([^{}]+)\}", full_source)
    if class_match:
        document_class = class_match.group(1).strip()

    heading_counts = {
        str(level): count_active(source, re.compile(pattern))
        for level, pattern in (
            (1, r"\\section\*?\s*\{"),
            (2, r"\\subsection\*?\s*\{"),
            (3, r"\\subsubsection\*?\s*\{"),
            (4, r"\\paragraph\*?\s*\{"),
        )
    }
    has_title_page = has(r"\\maketitlepage\b")
    has_table_of_contents = has(r"\\tableofcontents\b")
    return {
        "documentClass": document_class,
        "hasTitlePage": has_title_page,
        "hasTableOfContents": has_table_of_contents,
        "frontMatterRoman": has(r"\\pagenumbering\{Roman\}"),
        "bodyArabic": has(r"\\pagenumbering\{arabic\}"),
        "expectedSectionCount": 1 + int(has_title_page) + int(has_table_of_contents),
        "headingCounts": heading_counts,
        "figureCount": count_active(source, re.compile(r"\\begin\{figure\*?\}")),
        "imageCount": count_active(source, re.compile(r"\\includegraphics(?:\[[^\]]*\])?\{")),
        "tableCount": count_active(source, re.compile(r"\\begin\{(?:table\*?|longtable)\}")),
    }


def extract_metadata(source: str) -> dict[str, str]:
    metadata: dict[str, str] = {}
    for key in METADATA_KEYS:
        match = re.search(rf"\\{key}\{{([^{{}}]*)\}}", source)
        metadata[key] = match.group(1).strip() if match else ""
    return metadata


def replace_equation_references(source: str, formulas: list[dict[str, object]]) -> str:
    labels = {str(item["label"]): str(item["number"]) for item in formulas if item.get("label") and item.get("number")}
    source = re.sub(
        r"\\eqref\{([^{}]+)\}",
        lambda match: f"（{labels[match.group(1)]}）" if match.group(1) in labels else match.group(0),
        source,
    )
    return re.sub(
        r"\\ref\{([^{}]+)\}",
        lambda match: labels.get(match.group(1), match.group(0)),
        source,
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project-dir", required=True)
    parser.add_argument("--output-tex", required=True)
    parser.add_argument("--manifest", required=True)
    args = parser.parse_args()

    project_dir = Path(args.project_dir).resolve()
    source_path = project_dir / "main.tex"
    source = source_path.read_text(encoding="utf-8-sig")
    structure = extract_structure(source)
    mask = active_mask(source)
    formulas = collect_display(source, mask)
    formulas.extend(collect_inline(source, mask, formulas))
    formulas.sort(key=lambda item: int(item["start"]))
    classify_formulas(formulas)
    unclassified = [item for item in formulas if item["renderTarget"] == "review"]
    if unclassified:
        locations = "、".join(str(source.count("\n", 0, int(item["start"])) + 1) for item in unclassified[:8])
        raise ValueError(f"第 {locations} 行存在无法确定为普通文本或明确公式的数学片段，已拒绝导出。")
    for index, formula in enumerate(formulas, 1):
        formula["id"] = index
        formula["placeholder"] = placeholder(index)
        formula["equationToken"] = equation_token(index) if formula.get("number") else None
        formula["sourceLine"] = source.count("\n", 0, int(formula["start"])) + 1

    prepared = apply_replacements(source, formulas)
    prepared = remove_inactive_conditionals(prepared)
    prepared = replace_equation_references(prepared, formulas)
    prepared = replace_active_pattern(prepared, FRONT_MATTER_RE, "")
    prepared = replace_active_pattern(prepared, re.compile(r"\\maketitlepage\b"), "")
    prepared = replace_active_pattern(prepared, re.compile(r"\\tableofcontents\b"), "")
    prepared = replace_active_pattern(prepared, PAGENUMBERING_RE, "")
    prepared = replace_active_pattern(
        prepared,
        PARAGRAPH_LAYOUT_OVERRIDE_RE,
        r"\\newcommand\\circletexparagraphlayout",
    )
    prepared = replace_active_pattern(prepared, RAISEBOX_IMAGE_RE, r"\1")
    prepared, page_break_tokens = replace_page_breaks(prepared)
    prepared_mask = active_mask(prepared)
    remaining_display = [
        match for regex in (DISPLAY_RE, BRACKET_DISPLAY_RE) for match in regex.finditer(prepared)
        if prepared_mask[match.start()]
    ]
    if remaining_display:
        raise ValueError("仍有未提取的独立公式，已拒绝生成 Word。")
    remaining_inline = collect_inline(prepared, prepared_mask, [])
    if remaining_inline:
        raise ValueError("仍有未提取的行内公式，已拒绝生成 Word。")

    Path(args.output_tex).write_text(prepared, encoding="utf-8", newline="\n")
    manifest = {
        "version": 1,
        "source": str(source_path),
        "metadata": extract_metadata(source),
        "structure": structure,
        "pageBreakTokens": page_break_tokens,
        "mathSegmentCount": len(formulas),
        "formulaCount": sum(item["renderTarget"] == "mathtype" for item in formulas),
        "wordTextCount": sum(item["renderTarget"] == "word-text" for item in formulas),
        "inlineFormulaCount": sum(item["kind"] == "inline" for item in formulas),
        "displayFormulaCount": sum(item["kind"] == "display" for item in formulas),
        "formulas": [{key: value for key, value in item.items() if key not in {"start", "end"}} for item in formulas],
    }
    Path(args.manifest).write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({key: manifest[key] for key in ("mathSegmentCount", "formulaCount", "wordTextCount", "inlineFormulaCount", "displayFormulaCount")}, ensure_ascii=False))


if __name__ == "__main__":
    main()
