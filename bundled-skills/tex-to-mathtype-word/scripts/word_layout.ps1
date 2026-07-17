Set-StrictMode -Version Latest

function Get-CircleTexLayoutConfig([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "缺少 Word 版式配置：$Path"
  }
  $config = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
  if ([int]$config.version -ne 1 -or -not $config.page -or -not $config.body) {
    throw "Word 版式配置格式无效。"
  }
  return $config
}

function Convert-CmToPoints([object]$Word, [double]$Value) {
  return [double]$Word.CentimetersToPoints($Value)
}

function Set-CircleTexPageSetup([object]$Word, [object]$PageSetup, [System.Collections.IDictionary]$Config) {
  $page = $Config.page
  $PageSetup.Orientation = 0
  $PageSetup.PageWidth = Convert-CmToPoints $Word ([double]$page.widthCm)
  $PageSetup.PageHeight = Convert-CmToPoints $Word ([double]$page.heightCm)
  $PageSetup.TopMargin = Convert-CmToPoints $Word ([double]$page.topMarginCm)
  $PageSetup.BottomMargin = Convert-CmToPoints $Word ([double]$page.bottomMarginCm)
  $PageSetup.LeftMargin = Convert-CmToPoints $Word ([double]$page.leftMarginCm)
  $PageSetup.RightMargin = Convert-CmToPoints $Word ([double]$page.rightMarginCm)
  $PageSetup.HeaderDistance = [double]$page.headerDistancePt
  $PageSetup.FooterDistance = [double]$page.footerDistancePt
  try { $PageSetup.MirrorMargins = 0 } catch {}
}

function Set-CircleTexFont([object]$Font, [string]$LatinFont, [string]$EastAsiaFont, [double]$Size) {
  $Font.Name = $LatinFont
  try { $Font.NameAscii = $LatinFont } catch {}
  try { $Font.NameOther = $LatinFont } catch {}
  $Font.NameFarEast = $EastAsiaFont
  $Font.Size = $Size
}

function Set-CircleTexBodyStyle([object]$Word, [object]$Style, [System.Collections.IDictionary]$Config) {
  $body = $Config.body
  Set-CircleTexFont $Style.Font ([string]$body.latinFont) ([string]$body.eastAsiaFont) ([double]$body.fontSizePt)
  $Style.ParagraphFormat.FirstLineIndent = Convert-CmToPoints $Word ([double]$body.firstLineIndentCm)
  $Style.ParagraphFormat.LineSpacingRule = 4
  $Style.ParagraphFormat.LineSpacing = [double]$body.lineSpacingPt
  $Style.ParagraphFormat.SpaceBefore = [double]$body.spaceBeforePt
  $Style.ParagraphFormat.SpaceAfter = [double]$body.spaceAfterPt
  $Style.ParagraphFormat.WidowControl = $true
}

function Set-CircleTexStyles([object]$Word, [object]$Document, [System.Collections.IDictionary]$Config) {
  Set-CircleTexBodyStyle $Word $Document.Styles.Item(-1) $Config
  foreach ($name in @("First Paragraph", "Body Text", "正文", "List Paragraph", "列表段落")) {
    try { Set-CircleTexBodyStyle $Word $Document.Styles.Item($name) $Config } catch {}
  }

  foreach ($heading in $Config.headings) {
    $level = [int]$heading.level
    try { $style = $Document.Styles.Item(-1 - $level) } catch { continue }
    Set-CircleTexFont $style.Font "Times New Roman" "黑体" ([double]$heading.fontSizePt)
    $style.Font.Bold = $true
    $style.ParagraphFormat.Alignment = 0
    $style.ParagraphFormat.FirstLineIndent = 0
    $style.ParagraphFormat.LeftIndent = 0
    $style.ParagraphFormat.SpaceBefore = [double]$heading.spaceBeforePt
    $style.ParagraphFormat.SpaceAfter = [double]$heading.spaceAfterPt
    $style.ParagraphFormat.KeepWithNext = $true
  }

  try {
    $caption = $Document.Styles.Item(-35)
    Set-CircleTexFont $caption.Font ([string]$Config.caption.latinFont) `
      ([string]$Config.caption.eastAsiaFont) ([double]$Config.caption.fontSizePt)
    $caption.ParagraphFormat.Alignment = 1
    $caption.ParagraphFormat.FirstLineIndent = 0
    $caption.ParagraphFormat.SpaceBefore = [double]$Config.caption.spaceBeforePt
    $caption.ParagraphFormat.SpaceAfter = [double]$Config.caption.spaceAfterPt
    $caption.ParagraphFormat.KeepWithNext = $true
  } catch {}

  for ($level = 1; $level -le [int]$Config.toc.levels; $level += 1) {
    try {
      $tocStyle = $Document.Styles.Item(-19 - $level)
      Set-CircleTexFont $tocStyle.Font "Times New Roman" "宋体" 12
      $tocStyle.ParagraphFormat.FirstLineIndent = 0
      $tocStyle.ParagraphFormat.SpaceBefore = 0
      $tocStyle.ParagraphFormat.SpaceAfter = 0
      $tocStyle.ParagraphFormat.LineSpacingRule = 0
      $tocStyle.ParagraphFormat.LeftIndent = Convert-CmToPoints $Word ([double](0.74 * ($level - 1)))
    } catch {}
  }
}

function New-CircleTexReferenceDocx(
  [string]$OutputPath,
  [System.Collections.IDictionary]$Config
) {
  $word = $null
  $document = $null
  try {
    $word = New-Object -ComObject Word.Application
    $word.Visible = $false
    $word.DisplayAlerts = 0
    $document = $word.Documents.Add()
    Set-CircleTexPageSetup $word $document.Sections.Item(1).PageSetup $Config
    Set-CircleTexStyles $word $document $Config
    try { $document.BuiltInDocumentProperties.Item("Title").Value = "CircleTeX 内部参考模板" } catch {}
    $document.SaveAs2($OutputPath, 16)
  } finally {
    if ($document) { $document.Close(0) }
    if ($word) { $word.Quit() }
  }
}

function Find-CircleTexText([object]$Document, [string]$Text) {
  $range = $Document.Content.Duplicate
  $find = $range.Find
  $find.ClearFormatting()
  $find.Text = $Text
  $find.Forward = $true
  $find.Wrap = 0
  if ($find.Execute()) { return $Document.Range($range.Start, $range.End) }
  return $null
}

function Add-CircleTexSectionBeforeBody([object]$Document) {
  $range = $Document.Range(0, 0)
  $range.InsertBreak(2)
}

function Set-CircleTexCover(
  [object]$Word,
  [object]$Document,
  [int]$SectionIndex,
  [System.Collections.IDictionary]$Metadata,
  [System.Collections.IDictionary]$Config
) {
  $section = $Document.Sections.Item($SectionIndex)
  $range = $Document.Range($section.Range.Start, [Math]::Max($section.Range.Start, $section.Range.End - 1))
  $lines = @(
    [string]$Config.cover.school,
    "",
    [string]$Config.cover.reportLine,
    "",
    [string]$Config.cover.reportName,
    "",
    "学    院：`t$($Metadata.collegename)",
    "专    业：`t$($Metadata.majorname)",
    "姓    名：`t$($Metadata.studentname)",
    "学    号：`t$($Metadata.studentid)",
    "研究方向：`t$($Metadata.researchdir)",
    "指导老师：`t$($Metadata.supervisor)",
    "",
    (Get-Date -Format "yyyy年M月d日")
  )
  $range.Text = ($lines -join "`r") + "`r"
  $section = $Document.Sections.Item($SectionIndex)
  $section.Range.Style = $Document.Styles.Item(-1)
  $section.Range.ParagraphFormat.FirstLineIndent = 0
  $section.Range.ParagraphFormat.SpaceBefore = 0
  $section.Range.ParagraphFormat.SpaceAfter = 0
  Set-CircleTexFont $section.Range.Font "Times New Roman" "宋体" ([double]$Config.cover.fieldFontSizePt)

  $nonEmpty = New-Object System.Collections.Generic.List[object]
  foreach ($paragraph in $section.Range.Paragraphs) {
    $text = ([string]$paragraph.Range.Text).Trim([char]13, [char]7, [char]12, [char]32)
    if ($text) { $nonEmpty.Add($paragraph) }
  }
  if ($nonEmpty.Count -lt 10) { throw "封面结构生成不完整。" }

  for ($index = 0; $index -lt 3; $index += 1) {
    $paragraph = $nonEmpty[$index]
    $paragraph.Range.ParagraphFormat.Alignment = 1
    $paragraph.Range.Font.NameFarEast = [string]$Config.cover.titleFont
    $paragraph.Range.Font.Bold = $true
    $paragraph.Range.Font.Size = if ($index -eq 0) {
      [double]$Config.cover.schoolFontSizePt
    } else {
      [double]$Config.cover.reportFontSizePt
    }
  }
  $nonEmpty[0].Range.ParagraphFormat.SpaceBefore = Convert-CmToPoints $Word 1.5
  $nonEmpty[0].Range.ParagraphFormat.SpaceAfter = Convert-CmToPoints $Word 1.5
  $nonEmpty[1].Range.ParagraphFormat.SpaceAfter = Convert-CmToPoints $Word 1.0
  $nonEmpty[2].Range.ParagraphFormat.SpaceAfter = Convert-CmToPoints $Word 1.6

  for ($index = 3; $index -lt 9; $index += 1) {
    $paragraph = $nonEmpty[$index]
    $paragraph.Range.ParagraphFormat.Alignment = 0
    $paragraph.Range.ParagraphFormat.LeftIndent = Convert-CmToPoints $Word 2.0
    $paragraph.Range.ParagraphFormat.LineSpacingRule = 4
    $paragraph.Range.ParagraphFormat.LineSpacing = 28
    $paragraph.Range.ParagraphFormat.TabStops.ClearAll()
    [void]$paragraph.Range.ParagraphFormat.TabStops.Add((Convert-CmToPoints $Word 5.2), 0, 0)
  }
  $dateParagraph = $nonEmpty[$nonEmpty.Count - 1]
  $dateParagraph.Range.ParagraphFormat.Alignment = 1
  $dateParagraph.Range.ParagraphFormat.SpaceBefore = Convert-CmToPoints $Word 1.5
  $dateParagraph.Range.Font.Size = [double]$Config.cover.dateFontSizePt
}

function Set-CircleTexTableOfContents(
  [object]$Document,
  [int]$SectionIndex,
  [System.Collections.IDictionary]$Config
) {
  $section = $Document.Sections.Item($SectionIndex)
  $range = $Document.Range($section.Range.Start, [Math]::Max($section.Range.Start, $section.Range.End - 1))
  $range.Text = ([string]$Config.toc.title) + "`r"
  $section = $Document.Sections.Item($SectionIndex)
  $title = $section.Range.Paragraphs.Item(1).Range
  $title.Style = $Document.Styles.Item(-1)
  $title.ParagraphFormat.Alignment = 1
  $title.ParagraphFormat.FirstLineIndent = 0
  $title.ParagraphFormat.SpaceAfter = 10
  $title.Font.NameFarEast = [string]$Config.toc.titleFont
  $title.Font.Name = "Times New Roman"
  $title.Font.Bold = $true
  $title.Font.Size = [double]$Config.toc.titleFontSizePt
  $tocRange = $Document.Range($title.End, $title.End)
  [void]$Document.TablesOfContents.Add($tocRange, $true, 1, [int]$Config.toc.levels)
}

function Set-CircleTexHeaderFooter(
  [object]$Section,
  [System.Collections.IDictionary]$Config,
  [ValidateSet("cover", "front", "body")][string]$Role
) {
  $Section.PageSetup.DifferentFirstPageHeaderFooter = $false
  $header = $Section.Headers.Item(1)
  $footer = $Section.Footers.Item(1)
  try { $header.LinkToPrevious = $false } catch {}
  try { $footer.LinkToPrevious = $false } catch {}
  $header.Range.Text = ""
  $footer.Range.Text = ""
  if ($Role -eq "cover") {
    try { $header.Range.Borders.Item(-3).LineStyle = 0 } catch {}
    return
  }

  $header.Range.Text = [string]$Config.header.text
  $header.Range.ParagraphFormat.Alignment = 1
  $header.Range.Font.NameFarEast = [string]$Config.header.eastAsiaFont
  $header.Range.Font.Name = "Times New Roman"
  $header.Range.Font.Size = [double]$Config.header.fontSizePt
  if ([bool]$Config.header.bottomBorder) {
    try {
      $header.Range.Borders.Item(-3).LineStyle = 1
      $header.Range.Borders.Item(-3).LineWidth = 4
    } catch {}
  }
  $footer.Range.ParagraphFormat.Alignment = 1
  [void]$footer.Range.Fields.Add($footer.Range, 33)
  try {
    $footer.PageNumbers.RestartNumberingAtSection = $true
    $footer.PageNumbers.StartingNumber = 1
    $footer.PageNumbers.NumberStyle = if ($Role -eq "front") { 1 } else { 0 }
  } catch {
    throw "无法设置 $Role 分节的页码格式。"
  }
}

function Convert-CircleTexPageBreaks([object]$Document, [object[]]$Tokens) {
  $converted = 0
  foreach ($tokenValue in $Tokens) {
    $token = [string]$tokenValue
    $range = Find-CircleTexText $Document $token
    if (-not $range) { throw "Word 中缺少分页标记：$token" }
    $start = $range.Start
    $paragraph = $range.Paragraphs.Item(1).Range
    $paragraph.Text = ""
    $breakRange = $Document.Range($start, $start)
    $breakRange.InsertBreak(7)
    $converted += 1
  }
  return $converted
}

function Set-CircleTexEquationNumbers(
  [object]$Document,
  [System.Collections.IDictionary]$Manifest
) {
  foreach ($formula in $Manifest.formulas) {
    if ([string]$formula.kind -ne "display" -or -not $formula.number) { continue }
    $range = Find-CircleTexText $Document "($($formula.number))"
    if (-not $range) { continue }
    $paragraph = $range.Paragraphs.Item(1)
    $paragraph.Range.ParagraphFormat.FirstLineIndent = 0
    $paragraph.Range.ParagraphFormat.Alignment = 0
    $paragraph.Range.ParagraphFormat.TabStops.ClearAll()
    $setup = $paragraph.Range.Sections.Item(1).PageSetup
    $usableWidth = $setup.PageWidth - $setup.LeftMargin - $setup.RightMargin
    [void]$paragraph.Range.ParagraphFormat.TabStops.Add($usableWidth / 2, 1, 0)
    [void]$paragraph.Range.ParagraphFormat.TabStops.Add($usableWidth, 2, 0)
  }
}

function Get-CircleTexHeadingCounts([object]$Document) {
  $counts = [ordered]@{ "1" = 0; "2" = 0; "3" = 0; "4" = 0 }
  $names = @{}
  for ($level = 1; $level -le 4; $level += 1) {
    try { $names[[string]$Document.Styles.Item(-1 - $level).NameLocal] = [string]$level } catch {}
  }
  foreach ($paragraph in $Document.Paragraphs) {
    try {
      $styleName = [string]$paragraph.Range.Style.NameLocal
      if ($names.ContainsKey($styleName)) {
        $level = $names[$styleName]
        $counts[$level] = [int]$counts[$level] + 1
      }
    } catch {}
  }
  return $counts
}

function Test-CircleTexNear([double]$Actual, [double]$Expected, [double]$Tolerance = 1.0) {
  return [Math]::Abs($Actual - $Expected) -le $Tolerance
}

function Get-CircleTexLayoutAudit(
  [object]$Word,
  [object]$Document,
  [System.Collections.IDictionary]$Manifest,
  [System.Collections.IDictionary]$Config,
  [int]$ConvertedPageBreaks
) {
  $structure = $Manifest.structure
  $page = $Config.page
  $pageMismatches = New-Object System.Collections.Generic.List[string]
  foreach ($section in $Document.Sections) {
    $setup = $section.PageSetup
    $checks = @(
      @("页面宽度", [double]$setup.PageWidth, (Convert-CmToPoints $Word ([double]$page.widthCm))),
      @("页面高度", [double]$setup.PageHeight, (Convert-CmToPoints $Word ([double]$page.heightCm))),
      @("上边距", [double]$setup.TopMargin, (Convert-CmToPoints $Word ([double]$page.topMarginCm))),
      @("下边距", [double]$setup.BottomMargin, (Convert-CmToPoints $Word ([double]$page.bottomMarginCm))),
      @("左边距", [double]$setup.LeftMargin, (Convert-CmToPoints $Word ([double]$page.leftMarginCm))),
      @("右边距", [double]$setup.RightMargin, (Convert-CmToPoints $Word ([double]$page.rightMarginCm)))
    )
    foreach ($check in $checks) {
      if (-not (Test-CircleTexNear ([double]$check[1]) ([double]$check[2]))) {
        $pageMismatches.Add("第 $($section.Index) 节$($check[0])")
      }
    }
  }

  $expectedSections = [int]$structure.expectedSectionCount
  $sectionCount = [int]$Document.Sections.Count
  $coverIndex = if ([bool]$structure.hasTitlePage) { 1 } else { 0 }
  $tocIndex = if ([bool]$structure.hasTableOfContents) { 1 + $coverIndex } else { 0 }
  $bodyIndex = 1 + $coverIndex + [int]([bool]$structure.hasTableOfContents)
  $coverClean = $true
  if ($coverIndex -gt 0) {
    $coverSection = $Document.Sections.Item($coverIndex)
    $coverClean = -not ([string]$coverSection.Headers.Item(1).Range.Text).Trim() -and
      [int]$coverSection.Footers.Item(1).Range.Fields.Count -eq 0
  }

  $tocCount = [int]$Document.TablesOfContents.Count
  $frontRoman = $true
  if ($tocIndex -gt 0 -and [bool]$structure.frontMatterRoman) {
    try {
      $frontRoman = [int]$Document.Sections.Item($tocIndex).Footers.Item(1).PageNumbers.NumberStyle -eq 1
    } catch { $frontRoman = $false }
  }
  $bodyArabic = $true
  if ([bool]$structure.bodyArabic) {
    try {
      $bodyNumbers = $Document.Sections.Item($bodyIndex).Footers.Item(1).PageNumbers
      $bodyArabic = [int]$bodyNumbers.NumberStyle -eq 0 -and
        [bool]$bodyNumbers.RestartNumberingAtSection -and [int]$bodyNumbers.StartingNumber -eq 1
    } catch { $bodyArabic = $false }
  }

  $actualHeadings = Get-CircleTexHeadingCounts $Document
  $headingStatus = $true
  foreach ($level in @("1", "2", "3", "4")) {
    if ([int]$actualHeadings[$level] -lt [int]$structure.headingCounts[$level]) {
      $headingStatus = $false
    }
  }

  $pictureCount = 0
  foreach ($shape in $Document.InlineShapes) {
    try {
      if ([int]$shape.Type -in @(3, 4)) { $pictureCount += 1 }
    } catch {}
  }
  $tableCount = [int]$Document.Tables.Count
  return [ordered]@{
    pageSetup = [ordered]@{ status = ($pageMismatches.Count -eq 0); mismatchCount = $pageMismatches.Count; mismatches = @($pageMismatches) }
    sectionStructure = [ordered]@{ status = ($sectionCount -ge $expectedSections -and $coverClean); current = $sectionCount; expected = $expectedSections; coverClean = $coverClean; bodySection = $bodyIndex }
    pageNumbering = [ordered]@{ status = ($frontRoman -and $bodyArabic); frontMatterRoman = $frontRoman; bodyArabic = $bodyArabic }
    tableOfContents = [ordered]@{ status = (-not [bool]$structure.hasTableOfContents -or $tocCount -ge 1); current = $tocCount; expected = [int]([bool]$structure.hasTableOfContents) }
    headingCoverage = [ordered]@{ status = $headingStatus; actual = $actualHeadings; expected = $structure.headingCounts }
    figureCoverage = [ordered]@{ status = ($pictureCount -ge [int]$structure.imageCount); current = $pictureCount; expected = [int]$structure.imageCount }
    tableCoverage = [ordered]@{ status = ($tableCount -ge [int]$structure.tableCount); current = $tableCount; expected = [int]$structure.tableCount }
    pageBreaks = [ordered]@{ status = ($ConvertedPageBreaks -eq @($Manifest.pageBreakTokens).Count); current = $ConvertedPageBreaks; expected = @($Manifest.pageBreakTokens).Count }
    pageCount = [int]$Document.ComputeStatistics(2)
  }
}

function Invoke-CircleTexWordLayout(
  [string]$DocumentPath,
  [System.Collections.IDictionary]$Manifest,
  [System.Collections.IDictionary]$Config
) {
  $word = $null
  $document = $null
  try {
    $word = New-Object -ComObject Word.Application
    $word.Visible = $false
    $word.DisplayAlerts = 0
    $document = $word.Documents.Open($DocumentPath)
    if ([int]$document.OMaths.Count -ne 0) {
      throw "版式重建前检测到 $($document.OMaths.Count) 个 OMML 公式。"
    }

    Set-CircleTexStyles $word $document $Config
    $frontSectionCount = [int]([bool]$Manifest.structure.hasTitlePage) +
      [int]([bool]$Manifest.structure.hasTableOfContents)
    for ($index = 0; $index -lt $frontSectionCount; $index += 1) {
      Add-CircleTexSectionBeforeBody $document
    }
    foreach ($section in $document.Sections) {
      Set-CircleTexPageSetup $word $section.PageSetup $Config
    }

    $coverIndex = if ([bool]$Manifest.structure.hasTitlePage) { 1 } else { 0 }
    $tocIndex = if ([bool]$Manifest.structure.hasTableOfContents) { 1 + $coverIndex } else { 0 }
    $bodyIndex = 1 + $coverIndex + [int]([bool]$Manifest.structure.hasTableOfContents)
    if ($coverIndex -gt 0) {
      Set-CircleTexCover $word $document $coverIndex $Manifest.metadata $Config
      Set-CircleTexHeaderFooter $document.Sections.Item($coverIndex) $Config "cover"
    }
    if ($tocIndex -gt 0) {
      Set-CircleTexTableOfContents $document $tocIndex $Config
      Set-CircleTexHeaderFooter $document.Sections.Item($tocIndex) $Config "front"
    }
    Set-CircleTexHeaderFooter $document.Sections.Item($bodyIndex) $Config "body"
    for ($sectionIndex = $bodyIndex + 1; $sectionIndex -le [int]$document.Sections.Count; $sectionIndex += 1) {
      Set-CircleTexHeaderFooter $document.Sections.Item($sectionIndex) $Config "body"
    }

    $convertedPageBreaks = Convert-CircleTexPageBreaks $document @($Manifest.pageBreakTokens)
    Set-CircleTexEquationNumbers $document $Manifest
    foreach ($toc in $document.TablesOfContents) { [void]$toc.Update() }
    [void]$document.Fields.Update()
    $document.Repaginate()
    $audit = Get-CircleTexLayoutAudit $word $document $Manifest $Config $convertedPageBreaks
    $document.Save()
    return $audit
  } finally {
    if ($document) { $document.Close(0) }
    if ($word) { $word.Quit() }
  }
}
