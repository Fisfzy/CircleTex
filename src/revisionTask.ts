import { CodexResult, SourceMapping } from "./types";

export function buildRevisionTask(mapping: SourceMapping, instruction: string): string {
  const context = splitReadOnlyContext(mapping);
  return `你正在为 CircleTeX 执行一次局部、只读的 LaTeX 修订分析。

必须遵守以下约束：
1. 只能依据下方嵌入的 PDF 选区、选中源码和只读上下文进行分析；不得访问任何项目、路径或其他外部内容。
2. 不得调用工具、读取或修改文件，也不得执行命令或编译。
3. 只允许重写 <selected_source> 中的完整源码范围，不得建议修改范围外内容。
4. 保留必要的 LaTeX 命令、引用键、标签、公式语义和段落末尾换行。
5. 不得补造文献、数据、公式、图表含义或研究结论；证据不足时在替换文本中规范表达限制。
6. 所有自然语言使用简体中文。
7. 最终输出只能是一个合法 JSON 对象，不使用 Markdown 代码围栏，不附加解释：
{"summary":"一句话说明修改内容","replacement":"替换后的完整 LaTeX 源码字符串"}

用户在 PDF 中划选的可见文字：
<pdf_selection page="${mapping.selection.page}">
${mapping.selection.text}
</pdf_selection>

用户修改要求：
<instruction>
${instruction.trim()}
</instruction>

允许替换的源码范围（第 ${mapping.startLine}--${mapping.endLine} 行）：
<selected_source>
${mapping.sourceText}
</selected_source>

选中源码之前的只读上下文（从第 ${mapping.contextStartLine} 行开始，不能修改）：
<context_before>
${context.before}
</context_before>

选中源码之后的只读上下文（不能修改）：
<context_after>
${context.after}
</context_after>`;
}

function splitReadOnlyContext(mapping: SourceMapping): { before: string; after: string } {
  const precedingLines = Math.max(0, mapping.startLine - mapping.contextStartLine);
  let expectedStart = 0;
  for (let index = 0; index < precedingLines; index += 1) {
    const lineEnd = mapping.contextText.indexOf("\n", expectedStart);
    if (lineEnd < 0) {
      expectedStart = -1;
      break;
    }
    expectedStart = lineEnd + 1;
  }
  const actualStart = expectedStart >= 0 &&
    mapping.contextText.slice(expectedStart, expectedStart + mapping.sourceText.length) === mapping.sourceText
    ? expectedStart
    : mapping.contextText.indexOf(mapping.sourceText);
  if (actualStart < 0) {
    return { before: mapping.contextText, after: "" };
  }
  return {
    before: mapping.contextText.slice(0, actualStart),
    after: mapping.contextText.slice(actualStart + mapping.sourceText.length)
  };
}

export function parseRevisionResponse(response: string): unknown {
  const trimmed = response.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        // 统一由下方错误说明响应格式问题。
      }
    }
    throw new Error("AI 助手未返回合法 JSON，无法生成安全补丁。");
  }
}

export function validateRevisionResult(value: unknown, originalLength: number): CodexResult {
  if (!value || typeof value !== "object") {
    throw new Error("AI 助手返回值不是 JSON 对象。");
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.summary !== "string" || typeof candidate.replacement !== "string") {
    throw new Error("AI 助手返回值缺少 summary 或 replacement 字符串。");
  }
  const maximum = Math.max(20_000, originalLength * 8);
  if (candidate.replacement.length > maximum) {
    throw new Error("AI 助手返回的替换文本异常过长，已拒绝处理。");
  }
  if (candidate.replacement.includes("\0")) {
    throw new Error("AI 助手返回的替换文本包含非法空字符。");
  }
  const summary = candidate.summary.replace(/\s+/g, " ").trim();
  if (summary.length > 240 || summary.includes("\0")) {
    throw new Error("AI 助手返回的摘要格式无效或异常过长。");
  }
  return {
    summary: summary || "已生成局部修订建议",
    replacement: candidate.replacement
  };
}
