param(
  [Parameter(Mandatory = $true)][string]$ProjectDir,
  [Parameter(Mandatory = $true)][string]$OutputDir,
  [string]$PandocCommand = "pandoc",
  [string]$PythonCommand = "python",
  [switch]$Worker
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

function Quote-NativeArgument([string]$Value) {
  return '"' + $Value.Replace('"', '\"') + '"'
}

function Publish-NewLogLines(
  [string]$Path,
  [ref]$PublishedCount,
  [switch]$ErrorStream
) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return }
  $lines = @(Get-Content -LiteralPath $Path -Encoding utf8)
  for ($index = [int]$PublishedCount.Value; $index -lt $lines.Count; $index += 1) {
    if ($ErrorStream) {
      [Console]::Error.WriteLine($lines[$index])
    } else {
      Write-Output $lines[$index]
    }
  }
  $PublishedCount.Value = $lines.Count
}

if (-not $Worker) {
  $brokerTempRoot = (Get-Item -LiteralPath ([System.IO.Path]::GetTempPath())).FullName
  $brokerRoot = Join-Path $brokerTempRoot ("circletex-word-broker-" + [guid]::NewGuid().ToString("N"))
  $stdoutPath = Join-Path $brokerRoot "stdout.log"
  $stderrPath = Join-Path $brokerRoot "stderr.log"
  New-Item -ItemType Directory -Path $brokerRoot | Out-Null
  $pwsh = Join-Path $PSHOME "pwsh.exe"
  Get-ChildItem Env: | Where-Object {
    $_.Name -like "npm_*" -or
    $_.Name -like "ELECTRON_*" -or
    $_.Name -like "VSCODE_*" -or
    $_.Name -in @("NODE", "NODE_OPTIONS", "INIT_CWD")
  } | ForEach-Object {
    Remove-Item -LiteralPath ("Env:" + $_.Name) -ErrorAction SilentlyContinue
  }
  $machinePath = [System.Environment]::GetEnvironmentVariable("Path", "Machine")
  $userPath = [System.Environment]::GetEnvironmentVariable("Path", "User")
  $env:Path = (@($machinePath, $userPath) | Where-Object { $_ }) -join ";"
  $env:PYTHONUTF8 = "1"
  $env:PYTHONIOENCODING = "utf-8"
  $arguments = @(
    "-NoProfile",
    "-STA",
    "-File",
    (Quote-NativeArgument $PSCommandPath),
    "-ProjectDir",
    (Quote-NativeArgument $ProjectDir),
    "-OutputDir",
    (Quote-NativeArgument $OutputDir),
    "-PandocCommand",
    (Quote-NativeArgument $PandocCommand),
    "-PythonCommand",
    (Quote-NativeArgument $PythonCommand),
    "-Worker"
  )
  $process = $null
  $stdoutLines = 0
  $stderrLines = 0
  try {
    $process = Start-Process -FilePath $pwsh -ArgumentList $arguments -WindowStyle Hidden -PassThru `
      -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
    do {
      Start-Sleep -Milliseconds 200
      $process.Refresh()
      Publish-NewLogLines $stdoutPath ([ref]$stdoutLines)
      Publish-NewLogLines $stderrPath ([ref]$stderrLines) -ErrorStream
    } while (-not $process.HasExited)
    $process.WaitForExit()
    Publish-NewLogLines $stdoutPath ([ref]$stdoutLines)
    Publish-NewLogLines $stderrPath ([ref]$stderrLines) -ErrorStream
    exit $process.ExitCode
  } finally {
    if (
      (Split-Path -Parent $brokerRoot) -eq $brokerTempRoot -and
      (Split-Path -Leaf $brokerRoot) -like "circletex-word-broker-*"
    ) {
      Remove-Item -LiteralPath $brokerRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}

function Write-Stage(
  [int]$Percent,
  [string]$Message,
  [string]$StageId,
  [string]$StageLabel,
  [ValidateSet("pending", "running", "completed", "failed")][string]$State = "running",
  [Nullable[int]]$Current = $null,
  [Nullable[int]]$Total = $null,
  [string]$Unit = ""
) {
  $stage = [ordered]@{ id = $StageId; label = $StageLabel; state = $State }
  if ($null -ne $Current) { $stage.current = [int]$Current }
  if ($null -ne $Total) { $stage.total = [int]$Total }
  if ($Unit) { $stage.unit = $Unit }
  $event = [ordered]@{
    type = "progress"
    percent = $Percent
    message = $Message
    stage = $stage
    elapsedSeconds = [Math]::Floor($script:ExportStopwatch.Elapsed.TotalSeconds)
  }
  $event | ConvertTo-Json -Depth 5 -Compress | Write-Output
}

function Resolve-CommandPath([string]$Name, [string]$Label) {
  $command = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $command) { throw "未找到$Label：$Name" }
  return $command.Source
}

function Get-PdfPageCount([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  $pdfInfo = Get-Command "pdfinfo" -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $pdfInfo) { return $null }
  $lines = @(& $pdfInfo.Source $Path 2>$null)
  if ($LASTEXITCODE -ne 0) { return $null }
  foreach ($line in $lines) {
    if ([string]$line -match '^Pages:\s+(\d+)') { return [int]$Matches[1] }
  }
  return $null
}

function Inspect-Docx([string]$Path, [int]$ExpectedFormulaCount) {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive = [System.IO.Compression.ZipFile]::OpenRead($Path)
  try {
    $ommlCount = 0
    $mathTypeObjectCount = 0
    $unresolvedPlaceholderCount = 0
    foreach ($entry in $archive.Entries) {
      if (-not $entry.FullName.StartsWith("word/") -or -not $entry.FullName.EndsWith(".xml")) { continue }
      $reader = [System.IO.StreamReader]::new($entry.Open())
      try { $xml = $reader.ReadToEnd() } finally { $reader.Dispose() }
      $ommlCount += ([regex]::Matches($xml, "<m:oMath(?:Para)?(?:\s|>)")).Count
      $mathTypeObjectCount += ([regex]::Matches($xml, 'ProgID="Equation\.DSMT4"')).Count
      $unresolvedPlaceholderCount += ([regex]::Matches($xml, "CIRCLETEX(?:MATH|EQNUM)\d{6}")).Count
    }
    return [ordered]@{
      formulaCount = $ExpectedFormulaCount
      mathTypeObjectCount = $mathTypeObjectCount
      ommlCount = $ommlCount
      unresolvedPlaceholderCount = $unresolvedPlaceholderCount
      formulaTextFallbackCount = [Math]::Max(0, $ExpectedFormulaCount - $mathTypeObjectCount)
    }
  } finally {
    $archive.Dispose()
  }
}

function Test-WordReopen([string]$Path, [int]$ExpectedFormulaCount) {
  $word = $null
  $document = $null
  try {
    $word = New-Object -ComObject Word.Application
    $word.Visible = $false
    $word.DisplayAlerts = 0
    $document = $word.Documents.Open($Path, $false, $true)
    if ([int]$document.OMaths.Count -ne 0) {
      throw "Word 重开后检测到 $($document.OMaths.Count) 个 OMML 公式。"
    }
    $mathTypeCount = 0
    for ($index = 1; $index -le [int]$document.InlineShapes.Count; $index += 1) {
      try {
        if ([string]$document.InlineShapes.Item($index).OLEFormat.ProgID -eq "Equation.DSMT4") {
          $mathTypeCount += 1
        }
      } catch {
        continue
      }
    }
    if ($mathTypeCount -ne $ExpectedFormulaCount) {
      throw "Word 重开后的 MathType 对象数不一致：$mathTypeCount/$ExpectedFormulaCount。"
    }
    return $mathTypeCount
  } finally {
    if ($document) { $document.Close(0) }
    if ($word) { $word.Quit() }
  }
}

$project = (Resolve-Path -LiteralPath $ProjectDir).Path
if (-not (Test-Path -LiteralPath (Join-Path $project "main.tex") -PathType Leaf)) {
  throw "工作副本缺少 main.tex。"
}
$output = [System.IO.Path]::GetFullPath($OutputDir)
New-Item -ItemType Directory -Force -Path $output | Out-Null
$work = Join-Path $project ".circletex-word"
New-Item -ItemType Directory -Force -Path $work | Out-Null
$preparedTex = Join-Path $work "main_word_source.tex"
$manifestPath = Join-Path $work "formula-manifest.json"
$referenceDocx = Join-Path $work "circletex_reference.docx"
$rawDocx = Join-Path $work "main_word_raw.docx"
$finalDocx = Join-Path $output "main_mathtype.docx"
$reportJson = Join-Path $output "conversion-report.json"
$reportMarkdown = Join-Path $output "conversion-report.md"
$prepareScript = Join-Path $PSScriptRoot "prepare_tex_for_word.py"
$candidateScript = Join-Path $PSScriptRoot "build_mathtype_candidates.py"
$factoryScript = Join-Path $PSScriptRoot "compile_mathtype_payloads.py"
$insertScript = Join-Path $PSScriptRoot "insert_mathtype_objects.py"
$sanitizeMetadataScript = Join-Path $PSScriptRoot "sanitize_docx_metadata.py"
$layoutScript = Join-Path $PSScriptRoot "word_layout.ps1"
$layoutConfigPath = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\assets\hrbeu-midterm-word-layout.json"))
. $layoutScript
$layoutConfig = Get-CircleTexLayoutConfig $layoutConfigPath
$script:ExportStopwatch = [System.Diagnostics.Stopwatch]::StartNew()

Write-Stage 3 "正在检查 Pandoc、Word 与 MathType 环境" "prepare-copy" "准备副本"
$python = Resolve-CommandPath $PythonCommand "Python"
$pandoc = Resolve-CommandPath $PandocCommand "Pandoc"
$mathTypeProgId = Get-ItemProperty 'Registry::HKEY_CLASSES_ROOT\Equation.DSMT4\CLSID' -ErrorAction SilentlyContinue
if (-not $mathTypeProgId) { throw "未检测到 MathType 7 的 Equation.DSMT4 OLE 接口。" }

Write-Stage 7 "正在生成 CircleTeX 内部 Word 参考模板" "build-reference" "生成版式模板"
New-CircleTexReferenceDocx $referenceDocx $layoutConfig
if (-not (Test-Path -LiteralPath $referenceDocx -PathType Leaf)) {
  throw "内部 Word 参考模板生成失败。"
}
Write-Stage 9 "内部 Word 参考模板已生成" "build-reference" "生成版式模板" "completed"

Write-Stage 10 "正在从 main.tex 解析数学片段并分类" "parse-formulas" "解析数学片段"
& $python $prepareScript --project-dir $project --output-tex $preparedTex --manifest $manifestPath
if ($LASTEXITCODE -ne 0) { throw "LaTeX 公式提取失败，退出码 $LASTEXITCODE。" }
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
if ([int]$manifest.mathSegmentCount -lt 1) { throw "main.tex 中没有提取到数学片段，拒绝生成正式 Word。" }
if ([int]$manifest.formulaCount -lt 1) { throw "main.tex 中没有明确公式需要 MathType，当前导出器拒绝生成无 MathType 验收的正式 Word。" }
Write-Stage -Percent 18 -Message "数学片段已分类：普通文本与 MathType 公式已分流" -StageId "parse-formulas" `
  -StageLabel "解析数学片段" -State "completed" -Current ([int]$manifest.mathSegmentCount) `
  -Total ([int]$manifest.mathSegmentCount) -Unit "个数学片段"

Write-Stage 24 "正在生成无公式对象的基础 DOCX" "build-word" "生成基础 Word"
$resourcePath = "$project;$project\figures"
& $pandoc $preparedTex --from=latex --to=docx --resource-path=$resourcePath `
  --reference-doc=$referenceDocx --output=$rawDocx
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $rawDocx -PathType Leaf)) {
  throw "Pandoc 基础 DOCX 生成失败。"
}
Write-Stage 32 "基础 DOCX 已生成" "build-word" "生成基础 Word" "completed"

Write-Stage 38 "正在逐公式创建 MathType 可编辑对象" "create-mathtype" "创建 MathType"
$factoryTempRoot = (Get-Item -LiteralPath ([System.IO.Path]::GetTempPath())).FullName
$factoryWork = Join-Path $factoryTempRoot ("circletex-mt-" + [guid]::NewGuid().ToString("N"))
$factorySourceManifest = Join-Path $factoryWork "formula-source.json"
$factoryManifest = Join-Path $factoryWork "factory-manifest.json"
$factoryPayloads = Join-Path $factoryWork "payloads"
$factoryReport = Join-Path $factoryWork "factory-report.json"
New-Item -ItemType Directory -Path $factoryWork | Out-Null
$uniqueLatex = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
$factoryFormulas = @()
foreach ($formula in @($manifest.formulas | Where-Object { $_.renderTarget -eq "mathtype" })) {
  $latex = ([string]$formula.latex).Trim()
  if (-not $uniqueLatex.Add($latex)) { continue }
  $formulaId = "mt-{0:D6}" -f ($factoryFormulas.Count + 1)
  $factoryFormulas += [ordered]@{
    formula_id = $formulaId
    latex = $latex
    kind = [string]$formula.kind
    state = "PASS"
    final_mathtype_eligible = $true
    source_type = "tex"
    fallback_allowed = $false
  }
}
[ordered]@{ formulas = @($factoryFormulas) } |
  ConvertTo-Json -Depth 8 |
  Set-Content -LiteralPath $factorySourceManifest -Encoding utf8NoBOM
& $python $candidateScript $factorySourceManifest $factoryManifest
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $factoryManifest -PathType Leaf)) {
  throw "MathType 兼容候选生成失败，退出码 $LASTEXITCODE。"
}
& $python $factoryScript $factoryManifest --payload-dir $factoryPayloads --report $factoryReport
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $factoryReport -PathType Leaf)) {
  throw "MathType 单公式工厂失败，退出码 $LASTEXITCODE。"
}
$factoryEvidence = Get-Content -LiteralPath $factoryReport -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
$uniqueFormulaCount = [int]$factoryEvidence.counts.formula_count
$payloadPassCount = [int]$factoryEvidence.counts.pass_count
$semanticVerifiedCount = @($factoryEvidence.formulas | Where-Object {
  $_.state -eq "PASS" -and $_.content.semantic_equivalent -eq $true
}).Count
Write-Stage -Percent 54 -Message "MathType 载荷已通过保存重开与语义校验" `
  -StageId "create-mathtype" -StageLabel "创建 MathType" -State "completed" `
  -Current $payloadPassCount -Total $uniqueFormulaCount -Unit "个不同公式"

Write-Stage 55 "正在把 MathType 可编辑对象回填到 Word" "assemble-formulas" "装配公式"
& $python $insertScript --input-docx $rawDocx --output-docx $finalDocx --manifest $manifestPath --factory-report $factoryReport
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $finalDocx -PathType Leaf)) {
  throw "MathType 逐公式回填失败。"
}
Write-Stage -Percent 68 -Message "MathType 公式与普通数学文本已装配到 Word" `
  -StageId "assemble-formulas" -StageLabel "装配公式" -State "completed" `
  -Current ([int]$manifest.mathSegmentCount) -Total ([int]$manifest.mathSegmentCount) -Unit "个数学片段"
if (
  (Split-Path -Parent $factoryWork) -eq $factoryTempRoot -and
  (Split-Path -Leaf $factoryWork) -like "circletex-mt-*"
) {
  Remove-Item -LiteralPath $factoryWork -Recurse -Force
}

Write-Stage 70 "正在重建 Word 封面、目录、分节和论文样式" "apply-styles" "重建论文版式"
$layoutAudit = Invoke-CircleTexWordLayout $finalDocx $manifest $layoutConfig
$referencePdfPageCount = Get-PdfPageCount (Join-Path $project "main.pdf")
$pdfReference = if ($null -ne $referencePdfPageCount) {
  $pageDelta = [int]$layoutAudit.pageCount - [int]$referencePdfPageCount
  $allowedDelta = [Math]::Max(2, [Math]::Ceiling([int]$referencePdfPageCount * 0.1))
  [ordered]@{
    available = $true
    pageCount = [int]$referencePdfPageCount
    wordPageCount = [int]$layoutAudit.pageCount
    pageDelta = $pageDelta
    withinTolerance = ([Math]::Abs($pageDelta) -le $allowedDelta)
  }
} else {
  [ordered]@{ available = $false; wordPageCount = [int]$layoutAudit.pageCount }
}

& $python $sanitizeMetadataScript $finalDocx
if ($LASTEXITCODE -ne 0) {
  throw "DOCX 非可见元数据中的公式占位符清理失败。"
}
Write-Stage 82 "Word 封面、目录、分节和论文样式已重建" "apply-styles" "重建论文版式" "completed"

Write-Stage 86 "正在执行零 OMML 和公式完整性门禁" "validate-integrity" "完整性验收"
$inspection = Inspect-Docx $finalDocx ([int]$manifest.formulaCount)
$reopenStableCount = Test-WordReopen $finalDocx ([int]$manifest.formulaCount)
$status = if (
  $payloadPassCount -eq $uniqueFormulaCount -and
  $semanticVerifiedCount -eq $uniqueFormulaCount -and
  $reopenStableCount -eq $inspection.formulaCount -and
  $inspection.formulaCount -eq $inspection.mathTypeObjectCount -and
  $inspection.ommlCount -eq 0 -and
  $inspection.unresolvedPlaceholderCount -eq 0 -and
  $inspection.formulaTextFallbackCount -eq 0 -and
  [bool]$layoutAudit.pageSetup.status -and
  [bool]$layoutAudit.sectionStructure.status -and
  [bool]$layoutAudit.pageNumbering.status -and
  [bool]$layoutAudit.tableOfContents.status -and
  [bool]$layoutAudit.headingCoverage.status -and
  [bool]$layoutAudit.pageBreaks.status
) { "success" } else { "failed" }
$warnings = New-Object System.Collections.Generic.List[string]
$warnings.Add("Word 与 LaTeX 的断行、浮动体和分页机制不同，不保证与 main.pdf 逐页完全一致。")
if (-not [bool]$layoutAudit.figureCoverage.status) {
  $warnings.Add("图片覆盖不足：Word 中检测到 $($layoutAudit.figureCoverage.current)/$($layoutAudit.figureCoverage.expected) 个图片对象。")
}
if (-not [bool]$layoutAudit.tableCoverage.status) {
  $warnings.Add("表格覆盖不足：Word 中检测到 $($layoutAudit.tableCoverage.current)/$($layoutAudit.tableCoverage.expected) 个表格。")
}
if (-not [bool]$pdfReference.available) {
  $warnings.Add("未能读取 main.pdf 页数，已跳过 PDF 页数参照。")
} elseif (-not [bool]$pdfReference.withinTolerance) {
  $warnings.Add("Word 与 main.pdf 页数相差 $([Math]::Abs([int]$pdfReference.pageDelta)) 页，请重点复核复杂图表和分页位置。")
}
$report = [ordered]@{
  version = 3
  status = $status
  source = "main.tex"
  output = "main_mathtype.docx"
  generatedAt = (Get-Date).ToString("o")
  mathSegmentCount = [int]$manifest.mathSegmentCount
  formulaCount = $inspection.formulaCount
  wordTextCount = [int]$manifest.wordTextCount
  inlineFormulaCount = [int]$manifest.inlineFormulaCount
  displayFormulaCount = [int]$manifest.displayFormulaCount
  uniqueFormulaCount = $uniqueFormulaCount
  payloadPassCount = $payloadPassCount
  semanticVerifiedCount = $semanticVerifiedCount
  reopenStableCount = $reopenStableCount
  mathTypeObjectCount = $inspection.mathTypeObjectCount
  ommlCount = $inspection.ommlCount
  unresolvedPlaceholderCount = $inspection.unresolvedPlaceholderCount
  formulaTextFallbackCount = $inspection.formulaTextFallbackCount
  layoutProfile = [string]$layoutConfig.profile
  layoutAudit = $layoutAudit
  pdfReference = $pdfReference
  durationSeconds = [Math]::Floor($script:ExportStopwatch.Elapsed.TotalSeconds)
  qualityGates = [ordered]@{
    mathTypeObjects = [ordered]@{ status = ($inspection.mathTypeObjectCount -eq $inspection.formulaCount); current = $inspection.mathTypeObjectCount; total = $inspection.formulaCount }
    omml = [ordered]@{ status = ($inspection.ommlCount -eq 0); value = $inspection.ommlCount }
    unresolvedPlaceholders = [ordered]@{ status = ($inspection.unresolvedPlaceholderCount -eq 0); value = $inspection.unresolvedPlaceholderCount }
    formulaFallbacks = [ordered]@{ status = ($inspection.formulaTextFallbackCount -eq 0); value = $inspection.formulaTextFallbackCount }
    wordReopen = [ordered]@{ status = ($reopenStableCount -eq $inspection.formulaCount); current = $reopenStableCount; total = $inspection.formulaCount }
    pageSetup = $layoutAudit.pageSetup
    sectionStructure = $layoutAudit.sectionStructure
    pageNumbering = $layoutAudit.pageNumbering
    tableOfContents = $layoutAudit.tableOfContents
    headingCoverage = $layoutAudit.headingCoverage
    pageBreaks = $layoutAudit.pageBreaks
    figureCoverage = $layoutAudit.figureCoverage
    tableCoverage = $layoutAudit.tableCoverage
  }
  warnings = @($warnings)
}
$report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $reportJson -Encoding utf8NoBOM
@"
# CircleTeX MathType Word 转换报告

- 状态：$status
- LaTeX 数学片段总数：$($report.mathSegmentCount)
- MathType 明确公式：$($report.formulaCount)
- 普通 Word 数学文本：$($report.wordTextCount)
- 行内公式：$($report.inlineFormulaCount)
- 独立公式：$($report.displayFormulaCount)
- 不同公式：$($report.uniqueFormulaCount)
- MathType 载荷通过：$($report.payloadPassCount)
- 语义回译通过：$($report.semanticVerifiedCount)
- MathType 对象：$($report.mathTypeObjectCount)
- OMML 对象：$($report.ommlCount)
- 残留占位符：$($report.unresolvedPlaceholderCount)
- 公式文本或图片降级：$($report.formulaTextFallbackCount)
- Word 重开稳定对象：$($report.reopenStableCount)
- Word 分节：$($report.layoutAudit.sectionStructure.current)/$($report.layoutAudit.sectionStructure.expected)
- 自动目录：$($report.layoutAudit.tableOfContents.current)
- 标题结构门禁：$($report.layoutAudit.headingCoverage.status)
- 页面与页边距门禁：$($report.layoutAudit.pageSetup.status)
- 目录与正文页码门禁：$($report.layoutAudit.pageNumbering.status)
- 图片覆盖：$($report.layoutAudit.figureCoverage.current)/$($report.layoutAudit.figureCoverage.expected)
- 表格覆盖：$($report.layoutAudit.tableCoverage.current)/$($report.layoutAudit.tableCoverage.expected)
- Word 页数：$($report.layoutAudit.pageCount)
- 原 PDF 页数：$(if ($report.pdfReference.available) { $report.pdfReference.pageCount } else { "未读取" })
- 页数差：$(if ($report.pdfReference.available) { $report.pdfReference.pageDelta } else { "未计算" })
- 总耗时（秒）：$($report.durationSeconds)

正式稿要求公式完整性、页面、分节、页码、目录、标题和分页门禁全部通过。
"@ | Set-Content -LiteralPath $reportMarkdown -Encoding utf8NoBOM

if ($status -ne "success") {
  throw "MathType Word 未通过正式稿门禁，请查看 conversion-report.json。"
}
Write-Stage -Percent 100 -Message "MathType Word 已通过全部完整性门禁" `
  -StageId "validate-integrity" -StageLabel "完整性验收" -State "completed" `
  -Current ([int]$inspection.formulaCount) -Total ([int]$inspection.formulaCount) -Unit "个公式位置"
$report | ConvertTo-Json -Depth 8 -Compress | Write-Output
