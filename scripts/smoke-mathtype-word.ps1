$ErrorActionPreference = "Stop"
$env:PYTHONDONTWRITEBYTECODE = "1"
$root = Join-Path $env:TEMP ("circletex-word-smoke-" + [guid]::NewGuid().ToString("N"))
$project = Join-Path $root "paper"
$output = Join-Path $root "output"
New-Item -ItemType Directory -Path $project, $output | Out-Null
try {
  $metadataFixtureRoot = Join-Path $root "metadata-fixture"
  $metadataFixtureWord = Join-Path $metadataFixtureRoot "word"
  $metadataFixture = Join-Path $root "metadata-fixture.docx"
  New-Item -ItemType Directory -Force -Path $metadataFixtureWord | Out-Null
  @'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:tbl><w:tblPr><w:tblCaption w:val="CIRCLETEXMATH000001算例"/></w:tblPr><w:tr><w:tc><w:p><w:r><w:t>CIRCLETEXMATH000002</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>
'@ | Set-Content -LiteralPath (Join-Path $metadataFixtureWord "document.xml") -Encoding utf8NoBOM
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::CreateFromDirectory($metadataFixtureRoot, $metadataFixture)
  & python (Join-Path $PSScriptRoot "..\bundled-skills\tex-to-mathtype-word\scripts\sanitize_docx_metadata.py") $metadataFixture | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "DOCX 元数据清理烟测执行失败。" }
  $metadataAuditRoot = Join-Path $root "metadata-audit"
  Expand-Archive -LiteralPath $metadataFixture -DestinationPath $metadataAuditRoot -Force
  $metadataXml = Get-Content -Raw -LiteralPath (Join-Path $metadataAuditRoot "word\document.xml")
  if ($metadataXml -match "CIRCLETEXMATH000001" -or $metadataXml -notmatch "CIRCLETEXMATH000002") {
    throw "DOCX 元数据清理范围不符合预期。"
  }

  @'
\documentclass{article}
\usepackage{amsmath}
\collegename{测试学院}
\majorname{测试专业}
\studentname{测试学生}
\studentid{20260001}
\researchdir{MathType 自动化测试}
\supervisor{测试导师}
\thesistitle{CircleTeX MathType 测试}
\begin{document}
\maketitlepage
\pagenumbering{Roman}
\tableofcontents
\newpage
\pagenumbering{arabic}
\section{测试章节}
正文中的行内公式$x^2+y^2=1$应当可以编辑。
重复出现的公式$x^2+y^2=1$应复用已验证载荷。
普通数字$117$、单变量$x$、希腊字母$\alpha$和单位$\mathrm{MPa}$不应创建 MathType 对象。
\begin{equation}
\frac{a}{b}+\int_0^1 x^2\,\mathrm{d}x\label{eq:test}
\end{equation}
式\eqref{eq:test}用于测试编号。
\clearpage
\section{附加章节}
分页后的正文用于验证 LaTeX 强制分页和标题结构。
\end{document}
'@ | Set-Content -LiteralPath (Join-Path $project "main.tex") -Encoding utf8NoBOM
  Set-Content -LiteralPath (Join-Path $project "main.pdf") -Value "%PDF-1.7" -Encoding ascii
  $taskOutput = @(& (Join-Path $PSScriptRoot "..\bundled-skills\tex-to-mathtype-word\scripts\export_mathtype_word.ps1") `
    -ProjectDir $project -OutputDir $output)
  if ($LASTEXITCODE -ne 0) { throw "MathType Word 导出烟测执行失败，退出码 $LASTEXITCODE。" }
  $progressEvents = @()
  foreach ($line in $taskOutput) {
    try { $event = ([string]$line) | ConvertFrom-Json -ErrorAction Stop } catch { continue }
    if ($event.type -eq "progress") { $progressEvents += $event }
  }
  $createProgress = @($progressEvents | Where-Object { $_.stage.id -eq "create-mathtype" -and $_.stage.current -eq 2 })
  $assembleProgress = @($progressEvents | Where-Object { $_.stage.id -eq "assemble-formulas" -and $_.stage.current -eq 3 })
  $validationProgress = @($progressEvents | Where-Object { $_.stage.id -eq "validate-integrity" -and $_.stage.state -eq "completed" })
  if (
    $createProgress.Count -lt 1 -or $createProgress[-1].stage.total -ne 2 -or
    $assembleProgress.Count -lt 1 -or $assembleProgress[-1].stage.total -ne 3 -or
    $validationProgress.Count -ne 1
  ) {
    throw "MathType Word 烟测未收到完整的结构化阶段与真实计数。"
  }
  if (($progressEvents | ConvertTo-Json -Depth 8 -Compress) -match 'x\^2|\\frac\{a\}|canonical_latex') {
    throw "MathType Word 进度事件泄露了公式正文。"
  }
  $report = Get-Content -LiteralPath (Join-Path $output "conversion-report.json") -Raw -Encoding UTF8 | ConvertFrom-Json
  if (
    $report.status -ne "success" -or
    $report.mathSegmentCount -ne 7 -or
    $report.formulaCount -ne 3 -or
    $report.wordTextCount -ne 4 -or
    $report.uniqueFormulaCount -ne 2 -or
    $report.payloadPassCount -ne 2 -or
    $report.semanticVerifiedCount -ne 2 -or
    $report.reopenStableCount -ne 3 -or
    $report.mathTypeObjectCount -ne 3 -or
    $report.ommlCount -ne 0 -or
    $report.unresolvedPlaceholderCount -ne 0 -or
    $report.formulaTextFallbackCount -ne 0 -or
    -not $report.layoutAudit.pageSetup.status -or
    -not $report.layoutAudit.sectionStructure.status -or
    $report.layoutAudit.sectionStructure.current -lt 3 -or
    -not $report.layoutAudit.pageNumbering.status -or
    -not $report.layoutAudit.tableOfContents.status -or
    $report.layoutAudit.tableOfContents.current -ne 1 -or
    -not $report.layoutAudit.headingCoverage.status -or
    -not $report.layoutAudit.pageBreaks.status -or
    $report.layoutAudit.pageBreaks.current -ne 1
  ) {
    throw "MathType Word 烟测未通过公式或版式正式稿门禁。"
  }
  if (
    -not $report.qualityGates.mathTypeObjects.status -or
    -not $report.qualityGates.omml.status -or
    -not $report.qualityGates.unresolvedPlaceholders.status -or
    -not $report.qualityGates.formulaFallbacks.status -or
    -not $report.qualityGates.wordReopen.status -or
    -not $report.qualityGates.pageSetup.status -or
    -not $report.qualityGates.sectionStructure.status -or
    -not $report.qualityGates.pageNumbering.status -or
    -not $report.qualityGates.tableOfContents.status -or
    -not $report.qualityGates.headingCoverage.status -or
    -not $report.qualityGates.pageBreaks.status
  ) {
    throw "MathType Word 烟测未通过可视化质量门禁。"
  }
  Write-Output "MathType Word 烟测通过：封面、目录、三节页码体系、标题和强制分页均通过，3 个公式位置全部为 Equation.DSMT4。"
} finally {
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
