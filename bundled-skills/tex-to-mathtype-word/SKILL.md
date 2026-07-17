---
name: tex-to-mathtype-word
description: 将 CircleTeX 论文项目中的 main.tex 无底稿导出为保留学校版式、目录、分节、图表和标题结构的 Word；仅将明确具有二维数学结构的公式转换为 MathType 可编辑对象，数字、单字符和单位等简单数学片段保留为普通 Word 文本。用户要求导出 Word、生成 DOCX、恢复论文格式、使用 MathType 公式或禁止 OMML 时使用；正式产物必须同时通过版式结构门禁和零 OMML、零公式图片降级、数学片段分类与公式数量一致门禁。
---

# 保留版式的无底稿 MathType Word 导出

## 执行原则

- 以 `work/main.tex` 为唯一正文来源，以论文文档类为格式规则来源，以 `work/main.pdf` 为只读验收参照。
- 不要求或查找 `main.docx`，不改写论文正文，不修改 `input/` 或 `skill/`。
- 只运行本 Skill 提供的确定性导出脚本；Agent 负责调度和解释失败，不逐段重写内容。
- 明确公式必须是 `Equation.DSMT4` MathType OLE 对象。纯数字、单个变量或希腊字母、单位和简单文字标记必须写为普通 Word 文本；禁止 OMML 和公式图片。
- Pandoc 只负责语义转换；必须使用 Skill 动态生成的内部 `reference.docx`，并由 Word 重建封面、目录、分节和页码。
- 只有脚本返回成功，且公式门禁与版式结构门禁全部通过，才可把 DOCX 声明为正式产物。
- 修改版式映射或扩展其他论文模板时，先读取 [版式重建规范](references/layout-reconstruction.md)。

## 标准执行

在任务根目录运行：

```powershell
pwsh -NoProfile -STA -File "skill/scripts/export_mathtype_word.ps1" -ProjectDir "work" -OutputDir "output"
```

脚本自动完成：

1. 检查 PowerShell 7、Python、Pandoc、Word、MathType 7 和 `Equation.DSMT4`。
2. 从 LaTeX 提取数学片段、元数据、标题层级、图表数量、前置结构和强制分页标记；按明确公式、普通 Word 数学文本与无法判定项分类。
3. 根据内置版式配置动态生成 `reference.docx`，再用 Pandoc 生成不含公式对象的基础 DOCX。
4. 在隔离的后台 Word 会话中创建 `Equation.DSMT4`，通过对象级 `IDataObject` 写入 `TeX Input Language` 数据；每个候选都必须通过保存重开、反向回译和语义指纹校验后才可装配 DOCX。
5. 在 Word 中重建封面、自动目录和分节，恢复 A4 页面、正文、标题、题注、页眉横线、目录罗马页码、正文阿拉伯页码及 LaTeX 强制分页。
6. 更新目录、字段和分页，检查 MathType、OMML、占位符、页面、分节、页码、目录和标题结构，并重开最终 DOCX 核验稳定性。
7. 生成 `main_mathtype.docx`、`conversion-report.json` 和 `conversion-report.md`。

## 结果判定

读取 `output/conversion-report.json`：

- `status` 必须为 `success`。
- `formulaCount`（明确公式）必须等于 `mathTypeObjectCount`；`mathSegmentCount` 必须等于 `formulaCount + wordTextCount`。
- `payloadPassCount`、`semanticVerifiedCount` 必须等于 `uniqueFormulaCount`，`reopenStableCount` 必须等于 `formulaCount`。
- `ommlCount`、`unresolvedPlaceholderCount`、`formulaTextFallbackCount` 必须全部为 `0`；`wordTextCount` 是经过分类的正常普通文本，不属于公式降级。
- `layoutAudit.pageSetup`、`layoutAudit.sectionStructure`、`layoutAudit.pageNumbering`、`layoutAudit.tableOfContents` 和 `layoutAudit.headingCoverage` 必须全部通过。
- 任一条件不满足时返回失败，不得把中间 DOCX 声明为产物。

最终结构化回答只列出 `output/` 中实际存在的三个文件，并如实转述报告中的警告。
