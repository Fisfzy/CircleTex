export interface LatexProjectionToken {
  value: string;
  start: number;
  end: number;
}

export interface LatexOpaqueSpan {
  start: number;
  end: number;
  kind: "command" | "comment" | "math" | "verbatim";
}

export interface LatexProjection {
  tokens: LatexProjectionToken[];
  opaqueSpans: LatexOpaqueSpan[];
}

export interface StructuredCaretCandidate {
  offset: number;
  score: number;
}

const GRAPHEME_SEGMENTER = new Intl.Segmenter("und", { granularity: "grapheme" });
const MATH_ENVIRONMENTS = new Set([
  "math", "displaymath", "equation", "eqnarray", "align", "alignat", "flalign",
  "gather", "multline", "split", "aligned", "alignedat", "gathered", "cases",
  "matrix", "pmatrix", "bmatrix", "vmatrix", "smallmatrix"
]);
const VERBATIM_ENVIRONMENTS = new Set(["verbatim", "verbatimtab", "lstlisting", "minted"]);
const TABLE_ENVIRONMENTS = new Set(["array", "tabular", "tabularx", "longtable"]);
const TRANSPARENT_ONE_ARGUMENT_COMMANDS = new Set([
  "textbf", "textit", "textsl", "textsc", "textrm", "textsf", "texttt",
  "emph", "underline", "uline", "sout", "mbox", "hbox",
  "MakeUppercase", "MakeLowercase"
]);
const SPACING_COMMANDS = new Set([
  "quad", "qquad", "enspace", "thinspace", "medspace", "thickspace", "hspace", "vspace",
  "smallskip", "medskip", "bigskip", "newline", "linebreak", "noindent"
]);
const ESCAPED_VISIBLE: Record<string, string> = {
  "%": "%", "&": "&", "#": "#", "_": "_", "{": "{", "}": "}", "$": "$"
};

interface PdfGrapheme {
  value: string;
  index: number;
}

export function projectLatexSource(source: string): LatexProjection {
  const tokens: LatexProjectionToken[] = [];
  const opaqueSpans: LatexOpaqueSpan[] = [];

  const addOpaque = (start: number, end: number, kind: LatexOpaqueSpan["kind"]): void => {
    if (end > start) opaqueSpans.push({ start, end, kind });
  };
  const addVisible = (value: string, start: number, end: number): void => {
    for (const segment of normalizedGraphemes(value)) {
      tokens.push({ value: segment, start, end });
    }
  };

  const scan = (start: number, end: number): void => {
    let index = start;
    while (index < end) {
      const character = source[index];
      if (/\s/u.test(character)) {
        index += 1;
        continue;
      }
      if (character === "%" && !isEscaped(source, index)) {
        const lineEnd = source.indexOf("\n", index);
        const commentEnd = lineEnd < 0 || lineEnd >= end ? end : lineEnd + 1;
        addOpaque(index, commentEnd, "comment");
        index = commentEnd;
        continue;
      }
      if (character === "$" && !isEscaped(source, index)) {
        const delimiter = source[index + 1] === "$" ? "$$" : "$";
        const mathEnd = findUnescapedDelimiter(source, delimiter, index + delimiter.length, end);
        addOpaque(index, mathEnd, "math");
        index = mathEnd;
        continue;
      }
      if (character === "{") {
        const close = findBalancedGroupEnd(source, index, "{", "}", end);
        if (close === undefined) {
          addOpaque(index, end, "command");
          break;
        }
        addOpaque(index, close, "command");
        index = close;
        continue;
      }
      if (character === "}") {
        index += 1;
        continue;
      }
      if (character !== "\\") {
        const nextSpecial = findNextSpecial(source, index + 1, end);
        const chunkEnd = nextSpecial < 0 ? end : nextSpecial;
        for (const segment of GRAPHEME_SEGMENTER.segment(source.slice(index, chunkEnd))) {
          const tokenStart = index + segment.index;
          const tokenEnd = tokenStart + segment.segment.length;
          for (const normalized of normalizedGraphemes(segment.segment)) {
            tokens.push({ value: normalized, start: tokenStart, end: tokenEnd });
          }
        }
        index = chunkEnd;
        continue;
      }

      const next = source[index + 1];
      if (next && Object.hasOwn(ESCAPED_VISIBLE, next)) {
        addVisible(ESCAPED_VISIBLE[next], index, Math.min(end, index + 2));
        index += 2;
        continue;
      }
      if (next === "(" || next === "[") {
        const closing = next === "(" ? "\\)" : "\\]";
        const closingStart = source.indexOf(closing, index + 2);
        const mathEnd = closingStart < 0 || closingStart >= end ? end : closingStart + closing.length;
        addOpaque(index, mathEnd, "math");
        index = mathEnd;
        continue;
      }
      const command = parseCommand(source, index, end);
      if (!command) {
        addOpaque(index, Math.min(end, index + 1), "command");
        index += 1;
        continue;
      }
      if (command.name === "verb" || command.name === "verb*") {
        const verbEnd = findVerbEnd(source, command.end, end);
        addOpaque(index, verbEnd, "verbatim");
        index = verbEnd;
        continue;
      }
      if (command.name === "begin") {
        const environmentGroup = nextGroup(source, command.end, end, "{");
        if (!environmentGroup) {
          addOpaque(index, command.end, "command");
          index = command.end;
          continue;
        }
        const environment = source.slice(environmentGroup.contentStart, environmentGroup.contentEnd)
          .trim().replace(/\*$/u, "").toLocaleLowerCase("en-US");
        if (MATH_ENVIRONMENTS.has(environment) || TABLE_ENVIRONMENTS.has(environment) || VERBATIM_ENVIRONMENTS.has(environment)) {
          const closing = `\\end{${source.slice(environmentGroup.contentStart, environmentGroup.contentEnd)}}`;
          const closingStart = source.indexOf(closing, environmentGroup.end);
          const environmentEnd = closingStart < 0 || closingStart >= end ? end : closingStart + closing.length;
          addOpaque(index, environmentEnd, VERBATIM_ENVIRONMENTS.has(environment) ? "verbatim" : "math");
          index = environmentEnd;
        } else {
          addOpaque(index, environmentGroup.end, "command");
          index = environmentGroup.end;
        }
        continue;
      }
      if (command.name === "end") {
        const environmentGroup = nextGroup(source, command.end, end, "{");
        const commandEnd = environmentGroup?.end ?? command.end;
        addOpaque(index, commandEnd, "command");
        index = commandEnd;
        continue;
      }
      const normalizedCommandName = command.name.replace(/\*$/u, "");
      if (SPACING_COMMANDS.has(normalizedCommandName) || command.name === "par" || /^[,;:! ]$/u.test(command.name)) {
        const commandEnd = consumeImmediateGroups(source, command.end, end, 1).end;
        addOpaque(index, commandEnd, "command");
        index = commandEnd;
        continue;
      }
      if (TRANSPARENT_ONE_ARGUMENT_COMMANDS.has(command.name)) {
        const optional = consumeOptionalGroups(source, command.end, end);
        const visibleGroup = nextGroup(source, optional.end, end, "{");
        if (!visibleGroup) {
          addOpaque(index, command.end, "command");
          index = command.end;
          continue;
        }
        addOpaque(index, visibleGroup.contentStart, "command");
        scan(visibleGroup.contentStart, visibleGroup.contentEnd);
        addOpaque(visibleGroup.contentEnd, visibleGroup.end, "command");
        index = visibleGroup.end;
        continue;
      }
      if (command.name === "textcolor" || command.name === "href") {
        const metadata = nextGroup(source, command.end, end, "{");
        const visibleGroup = metadata ? nextGroup(source, metadata.end, end, "{") : undefined;
        if (metadata && visibleGroup) {
          addOpaque(index, visibleGroup.contentStart, "command");
          scan(visibleGroup.contentStart, visibleGroup.contentEnd);
          addOpaque(visibleGroup.contentEnd, visibleGroup.end, "command");
          index = visibleGroup.end;
          continue;
        }
      }
      const consumed = consumeImmediateGroups(source, command.end, end);
      const commandEnd = consumed.end;
      addOpaque(index, commandEnd, "command");
      index = commandEnd;
    }
  };

  scan(0, source.length);
  return {
    tokens: tokens.sort((left, right) => left.start - right.start || left.end - right.end),
    opaqueSpans: mergeOpaqueSpans(opaqueSpans)
  };
}

export function isEditableLatexBoundary(source: string, offset: number): boolean {
  if (!Number.isInteger(offset) || offset < 0 || offset > source.length) return false;
  return !projectLatexSource(source).opaqueSpans.some((span) => span.start < offset && offset < span.end);
}

export function isEditableLatexTextRange(source: string, start: number, end: number): boolean {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > source.length) {
    return false;
  }
  const projection = projectLatexSource(source);
  if (projection.opaqueSpans.some((span) => span.start < end && span.end > start)) return false;
  const tokens = projection.tokens.filter((token) => token.start >= start && token.end <= end);
  const visible = normalizedGraphemes(source.slice(start, end));
  return visible.length > 0 && tokens.map((token) => token.value).join("") === visible.join("");
}

export function structuredCaretCandidates(
  source: string,
  pdfText: string,
  caretVisibleOffset: number
): StructuredCaretCandidate[] {
  const projection = projectLatexSource(source);
  const pdf = normalizedPdfGraphemes(pdfText);
  if (!Number.isInteger(caretVisibleOffset) || caretVisibleOffset < 0 || caretVisibleOffset > pdf.length) return [];
  const scored = new Map<number, number>();
  const leftAnchors = buildPdfAnchors(pdf, caretVisibleOffset, -1);
  const rightAnchors = buildPdfAnchors(pdf, caretVisibleOffset, 1);

  const record = (offset: number, score: number): void => {
    if (!isEditableLatexBoundary(source, offset)) return;
    scored.set(offset, Math.max(scored.get(offset) ?? Number.NEGATIVE_INFINITY, score));
  };

  for (const anchor of leftAnchors.filter((item) => item.gap === 0)) {
    for (const occurrence of tokenSequenceStarts(projection.tokens, anchor.values)) {
      const token = projection.tokens[occurrence + anchor.values.length - 1];
      record(token.end, anchor.values.length);
    }
  }
  for (const anchor of rightAnchors.filter((item) => item.gap === 0)) {
    for (const occurrence of tokenSequenceStarts(projection.tokens, anchor.values)) {
      record(projection.tokens[occurrence].start, anchor.values.length);
    }
  }

  for (const left of leftAnchors) {
    for (const right of rightAnchors) {
      const leftOccurrences = tokenSequenceStarts(projection.tokens, left.values);
      const rightOccurrences = tokenSequenceStarts(projection.tokens, right.values);
      for (const leftStart of leftOccurrences) {
        const leftEndIndex = leftStart + left.values.length - 1;
        for (const rightStart of rightOccurrences) {
          if (rightStart !== leftEndIndex + 1) continue;
          const leftToken = projection.tokens[leftEndIndex];
          const rightToken = projection.tokens[rightStart];
          const opaque = projection.opaqueSpans.filter((span) => span.start >= leftToken.end && span.end <= rightToken.start);
          const score = 100 + left.values.length + right.values.length - 2 * (left.gap + right.gap);
          if (left.gap > 0 && right.gap > 0) continue;
          if (left.gap > 0 && right.gap === 0) {
            record(rightToken.start, score);
          } else if (left.gap === 0 && right.gap > 0) {
            record(leftToken.end, score);
          } else if (opaque.length === 0) {
            record(rightToken.start, score);
          } else {
            record(opaque[0].start, score - 1);
            record(opaque.at(-1)!.end, score - 1);
          }
        }
      }
    }
  }

  const maximum = Math.max(...scored.values(), Number.NEGATIVE_INFINITY);
  return [...scored.entries()]
    .filter(([, score]) => score === maximum)
    .map(([offset, score]) => ({ offset, score }))
    .sort((left, right) => left.offset - right.offset);
}

export function adjacentEditableLatexRange(
  source: string,
  offset: number,
  direction: "backward" | "forward"
): { start: number; end: number } | undefined {
  const projection = projectLatexSource(source);
  const token = direction === "backward"
    ? [...projection.tokens].reverse().find((item) => item.end <= offset && /^\s*$/u.test(source.slice(item.end, offset)))
    : projection.tokens.find((item) => item.start >= offset && /^\s*$/u.test(source.slice(offset, item.start)));
  return token ? { start: token.start, end: token.end } : undefined;
}

function buildPdfAnchors(pdf: PdfGrapheme[], caret: number, direction: -1 | 1): Array<{ values: string[]; gap: number }> {
  const anchors: Array<{ values: string[]; gap: number }> = [];
  const maximumGap = Math.min(8, direction < 0 ? caret : pdf.length - caret);
  for (let gap = 0; gap <= maximumGap; gap += 1) {
    const available = direction < 0 ? caret - gap : pdf.length - caret - gap;
    for (const length of [12, 10, 8, 6, 4, 3].filter((value) => value <= available)) {
      const start = direction < 0 ? caret - gap - length : caret + gap;
      const values = pdf.slice(start, start + length).map((item) => item.value);
      if ((values.join("").match(/[\p{L}\p{N}]/gu)?.length ?? 0) >= 3) anchors.push({ values, gap });
    }
  }
  return anchors;
}

function tokenSequenceStarts(tokens: readonly LatexProjectionToken[], wanted: readonly string[]): number[] {
  const starts: number[] = [];
  for (let index = 0; index <= tokens.length - wanted.length; index += 1) {
    if (wanted.every((value, wantedIndex) => tokens[index + wantedIndex].value === value)) starts.push(index);
  }
  return starts;
}

function normalizedPdfGraphemes(value: string): PdfGrapheme[] {
  return normalizedGraphemes(value).map((item, index) => ({ value: item, index }));
}

function normalizedGraphemes(value: string): string[] {
  const result: string[] = [];
  for (const sourceSegment of GRAPHEME_SEGMENTER.segment(value)) {
    const normalized = sourceSegment.segment.normalize("NFKC").replace(/\s/gu, "");
    for (const segment of GRAPHEME_SEGMENTER.segment(normalized)) {
      if (segment.segment) result.push(segment.segment);
    }
  }
  return result;
}

function parseCommand(source: string, start: number, end: number): { name: string; end: number } | undefined {
  if (source[start] !== "\\" || start + 1 >= end) return undefined;
  let index = start + 1;
  if (/[A-Za-z@]/u.test(source[index])) {
    while (index < end && /[A-Za-z@]/u.test(source[index])) index += 1;
    if (source[index] === "*") index += 1;
  } else {
    index += 1;
  }
  return { name: source.slice(start + 1, index), end: index };
}

interface GroupRange {
  start: number;
  contentStart: number;
  contentEnd: number;
  end: number;
}

function nextGroup(source: string, from: number, end: number, opener: "{" | "["): GroupRange | undefined {
  const start = skipWhitespace(source, from, end);
  if (source[start] !== opener) return undefined;
  const closer = opener === "{" ? "}" : "]";
  const groupEnd = findBalancedGroupEnd(source, start, opener, closer, end);
  return groupEnd === undefined ? undefined : {
    start,
    contentStart: start + 1,
    contentEnd: groupEnd - 1,
    end: groupEnd
  };
}

function consumeOptionalGroups(source: string, from: number, end: number): { end: number } {
  let index = from;
  while (true) {
    const group = nextGroup(source, index, end, "[");
    if (!group) return { end: index };
    index = group.end;
  }
}

function consumeImmediateGroups(source: string, from: number, end: number, maximum = Number.POSITIVE_INFINITY): { end: number } {
  let index = from;
  let count = 0;
  while (count < maximum) {
    const optional = nextGroup(source, index, end, "[");
    const required = optional ? undefined : nextGroup(source, index, end, "{");
    const group = optional ?? required;
    if (!group) break;
    index = group.end;
    count += 1;
  }
  return { end: index };
}

function findBalancedGroupEnd(source: string, start: number, opener: string, closer: string, end: number): number | undefined {
  let depth = 0;
  for (let index = start; index < end; index += 1) {
    if (isEscaped(source, index)) continue;
    if (source[index] === opener) depth += 1;
    if (source[index] === closer) {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return undefined;
}

function findUnescapedDelimiter(source: string, delimiter: string, from: number, end: number): number {
  let index = from;
  while (index < end) {
    const found = source.indexOf(delimiter, index);
    if (found < 0 || found >= end) return end;
    if (!isEscaped(source, found)) return found + delimiter.length;
    index = found + delimiter.length;
  }
  return end;
}

function findVerbEnd(source: string, from: number, end: number): number {
  const delimiter = source[from];
  if (!delimiter || /\s/u.test(delimiter)) return Math.min(end, from);
  const closing = source.indexOf(delimiter, from + 1);
  return closing < 0 || closing >= end ? end : closing + 1;
}

function findNextSpecial(source: string, from: number, end: number): number {
  for (let index = from; index < end; index += 1) {
    if (/[\\{}$%\s]/u.test(source[index])) return index;
  }
  return -1;
}

function skipWhitespace(source: string, from: number, end: number): number {
  let index = from;
  while (index < end && /\s/u.test(source[index])) index += 1;
  return index;
}

function isEscaped(source: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function mergeOpaqueSpans(spans: LatexOpaqueSpan[]): LatexOpaqueSpan[] {
  const ordered = [...spans].sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: LatexOpaqueSpan[] = [];
  for (const span of ordered) {
    const previous = merged.at(-1);
    if (previous && span.start <= previous.end && span.kind === previous.kind) {
      previous.end = Math.max(previous.end, span.end);
    } else {
      merged.push({ ...span });
    }
  }
  return merged;
}
