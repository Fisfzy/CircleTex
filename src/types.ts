export interface PdfPoint {
  x: number;
  y: number;
}

export interface PdfRect extends PdfPoint {
  width: number;
  height: number;
}

interface BasePdfSelection {
  text: string;
  page: number;
  start: PdfPoint;
  end: PdfPoint;
}

export interface TextPdfSelection extends BasePdfSelection {
  kind: "text";
  contextBefore?: string;
  contextAfter?: string;
}

export interface SyncTexViewRecord {
  page: number;
  x: number;
  y: number;
  h?: number;
  v?: number;
  width?: number;
  height?: number;
}

export interface RegionPdfSelection extends BasePdfSelection {
  kind: "region";
  bounds: PdfRect;
  anchors: PdfPoint[];
}

export type PdfSelection = TextPdfSelection | RegionPdfSelection;

export interface ProjectPaths {
  root: string;
  tex: string;
  pdf: string;
  syncTex: string;
}

export interface SyncTexRecord {
  input: string;
  line: number;
  column?: number;
}

export interface SourceMapping {
  id: string;
  sourcePath: string;
  startLine: number;
  endLine: number;
  startOffset: number;
  endOffset: number;
  sourceText: string;
  contextText: string;
  contextStartLine: number;
  documentHash: string;
  normalizedDocumentHash: string;
  selection: PdfSelection;
  confidenceNote?: string;
  requiresConfirmation?: boolean;
}

export interface CodexResult {
  summary: string;
  replacement: string;
}

export interface RevisionCandidate extends CodexResult {
  id: string;
  mapping: SourceMapping;
  baseText: string;
  previewText: string;
}

export interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}
