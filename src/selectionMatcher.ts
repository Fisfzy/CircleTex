export function hasTextualOverlap(pdfText: string, sourceText: string): boolean {
  const normalize = (value: string): string => value
    .normalize("NFKC")
    .replace(/\\[A-Za-z@]+\*?(?:\[[^\]]*\])?/g, "")
    .replace(/[^\p{Script=Han}A-Za-z0-9]+/gu, "")
    .toLowerCase();
  const selected = normalize(pdfText);
  const source = normalize(sourceText);
  if (selected.length < 4) {
    return false;
  }
  const windowLength = Math.min(8, selected.length);
  for (let index = 0; index <= selected.length - windowLength; index += 1) {
    if (source.includes(selected.slice(index, index + windowLength))) {
      return true;
    }
  }
  return false;
}
