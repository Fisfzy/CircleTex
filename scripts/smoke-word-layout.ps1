param([string]$ProjectDir = "")

$ErrorActionPreference = "Stop"
$env:PYTHONDONTWRITEBYTECODE = "1"
$root = Join-Path $env:TEMP ("circletex-layout-smoke-" + [guid]::NewGuid().ToString("N"))
$project = if ($ProjectDir) { (Resolve-Path -LiteralPath $ProjectDir).Path } else { Join-Path $root "paper" }
$work = Join-Path $root "work"
New-Item -ItemType Directory -Path $work | Out-Null
try {
  if (-not $ProjectDir) {
    New-Item -ItemType Directory -Path $project | Out-Null
  @'
\documentclass{article}
\collegename{测试学院}
\majorname{测试专业}
\studentname{测试学生}
\studentid{20260001}
\researchdir{Word 版式测试}
\supervisor{测试导师}
\thesistitle{CircleTeX Word 版式测试}
\begin{document}
\maketitlepage
\pagenumbering{Roman}
\tableofcontents
\newpage
\pagenumbering{arabic}
\section{第一节}
第一节正文。
\clearpage
\section{第二节}
第二节正文。
\end{document}
'@ | Set-Content -LiteralPath (Join-Path $project "main.tex") -Encoding utf8NoBOM
  }

  $skillRoot = Join-Path $PSScriptRoot "..\bundled-skills\tex-to-mathtype-word"
  $prepare = Join-Path $skillRoot "scripts\prepare_tex_for_word.py"
  $layoutScript = Join-Path $skillRoot "scripts\word_layout.ps1"
  $configPath = Join-Path $skillRoot "assets\hrbeu-midterm-word-layout.json"
  $prepared = Join-Path $work "prepared.tex"
  $manifestPath = Join-Path $work "manifest.json"
  $referenceDocx = Join-Path $work "reference.docx"
  $documentPath = Join-Path $work "layout.docx"

  & python $prepare --project-dir $project --output-tex $prepared --manifest $manifestPath | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Word 版式预处理烟测失败。" }
  . $layoutScript
  $config = Get-CircleTexLayoutConfig $configPath
  $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
  New-CircleTexReferenceDocx $referenceDocx $config
  $resourcePath = "$project;$project\figures"
  & pandoc $prepared --from=latex --to=docx --resource-path=$resourcePath `
    --reference-doc=$referenceDocx --output=$documentPath
  if ($LASTEXITCODE -ne 0) { throw "Word 版式 Pandoc 烟测失败。" }
  $audit = Invoke-CircleTexWordLayout $documentPath $manifest $config
  if (
    -not $audit.pageSetup.status -or
    -not $audit.sectionStructure.status -or
    $audit.sectionStructure.current -lt 3 -or
    -not $audit.pageNumbering.status -or
    -not $audit.tableOfContents.status -or
    $audit.tableOfContents.current -ne 1 -or
    -not $audit.headingCoverage.status -or
    $audit.headingCoverage.actual."1" -lt 2 -or
    -not $audit.pageBreaks.status -or
    $audit.pageBreaks.current -ne 1 -or
    $audit.pageCount -lt 3
  ) {
    $audit | ConvertTo-Json -Depth 8 | Write-Output
    throw "Word 版式烟测未通过。"
  }
  if ($ProjectDir) {
    $audit | ConvertTo-Json -Depth 8 | Write-Output
    Write-Output "真实论文 Word 版式审计通过。"
  } else {
    Write-Output "Word 版式烟测通过：A4 页面、封面、自动目录、三节页码体系、标题和强制分页均正确。"
  }
} finally {
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
