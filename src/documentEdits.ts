import { PendingImageEdit, validatePendingImageEdit } from "./imageEditResolver";
import {
  applyDirectManualEdits,
  escapeLatexPlainText,
  PendingManualEdit,
  validateNoOverlappingManualEdits
} from "./manualEdits";

export type PendingDocumentEdit = PendingManualEdit | PendingImageEdit;

export function isPendingImageEdit(edit: PendingDocumentEdit): edit is PendingImageEdit {
  return "editType" in edit && edit.editType === "image";
}

export function validateNoOverlappingDocumentEdits(edits: readonly PendingDocumentEdit[]): void {
  const textEdits = edits.filter((edit): edit is PendingManualEdit => !isPendingImageEdit(edit));
  validateNoOverlappingManualEdits(textEdits);
  const identifiers = new Set<string>();
  for (const edit of edits) {
    if (identifiers.has(edit.id)) throw new Error(`待编译编辑标识重复：${edit.id}`);
    identifiers.add(edit.id);
  }
  const ordered = [...edits].sort((left, right) => left.startOffset - right.startOffset || left.endOffset - right.endOffset);
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    const imageBoundaryConflict = (isPendingImageEdit(previous) || isPendingImageEdit(current)) && (
      current.startOffset === previous.startOffset &&
      (current.startOffset === current.endOffset || previous.startOffset === previous.endOffset)
    );
    if (current.startOffset < previous.endOffset || imageBoundaryConflict) {
      throw new Error(`待编译编辑范围重叠：${previous.id} 与 ${current.id}`);
    }
  }
}

export function applyDirectDocumentEdits(baseText: string, edits: readonly PendingDocumentEdit[]): string {
  const textEdits = edits.filter((edit): edit is PendingManualEdit => !isPendingImageEdit(edit));
  applyDirectManualEdits(baseText, textEdits);
  validateNoOverlappingDocumentEdits(edits);
  for (const edit of edits) if (isPendingImageEdit(edit)) validatePendingImageEdit(baseText, edit);

  const insertions = new Map<number, string[]>();
  const replacements: Array<{ startOffset: number; endOffset: number; replacement: string }> = [];
  for (const edit of edits) {
    if (isPendingImageEdit(edit)) {
      replacements.push({ startOffset: edit.startOffset, endOffset: edit.endOffset, replacement: edit.replacementText });
    } else if (edit.kind === "insertBefore" || edit.kind === "insertAfter") {
      const position = edit.kind === "insertBefore" ? edit.startOffset : edit.endOffset;
      const values = insertions.get(position) ?? [];
      values.push(escapeLatexPlainText(edit.insertedText));
      insertions.set(position, values);
    } else {
      replacements.push({
        startOffset: edit.startOffset,
        endOffset: edit.endOffset,
        replacement: edit.kind === "replace" ? escapeLatexPlainText(edit.insertedText) : ""
      });
    }
  }
  const patches = [
    ...replacements,
    ...[...insertions.entries()].map(([position, values]) => ({
      startOffset: position,
      endOffset: position,
      replacement: values.join("")
    }))
  ].sort((left, right) => right.startOffset - left.startOffset || right.endOffset - left.endOffset);
  let result = baseText;
  for (const patch of patches) {
    result = result.slice(0, patch.startOffset) + patch.replacement + result.slice(patch.endOffset);
  }
  return result;
}
