export interface TextEdit {
  start: number;
  end: number;
  replacement: string;
}

export function applyTextEdits(code: string, edits: TextEdit[]): string {
  if (edits.length === 0) return code;
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  let out = code;
  for (const edit of sorted) {
    out = out.slice(0, edit.start) + edit.replacement + out.slice(edit.end);
  }
  return out;
}
