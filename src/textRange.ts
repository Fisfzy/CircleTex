export function computeLineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) {
      starts.push(index + 1);
    }
  }
  if (starts.at(-1) === text.length && text.length > 0) {
    starts.pop();
  }
  return starts;
}
