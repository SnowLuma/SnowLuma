const ESC = 0x1b;
const BEL = 0x07;
const C1_CSI = 0x9b;
const C1_ST = 0x9c;
const C1_OSC = 0x9d;
const C1_STRING_STARTERS = new Set([0x90, 0x98, 0x9e, 0x9f]);

function skipCsi(line: string, start: number): number {
  for (let i = start; i < line.length; i += 1) {
    const code = line.charCodeAt(i);
    if (code >= 0x40 && code <= 0x7e) return i + 1;
  }
  return line.length;
}

function skipControlString(line: string, start: number, allowBell: boolean): number {
  for (let i = start; i < line.length; i += 1) {
    const code = line.charCodeAt(i);
    if (allowBell && code === BEL) return i + 1;
    if (code === C1_ST) return i + 1;
    if (code === ESC && line.charCodeAt(i + 1) === 0x5c) return i + 2;
  }
  return line.length;
}

function skipEscSequence(line: string, start: number): number {
  if (start >= line.length) return line.length;

  const first = line.charCodeAt(start);
  if (first === 0x5b) return skipCsi(line, start + 1);
  if (first === 0x5d) return skipControlString(line, start + 1, true);
  if (first === 0x50 || first === 0x58 || first === 0x5e || first === 0x5f) {
    return skipControlString(line, start + 1, false);
  }

  let i = start;
  while (i < line.length) {
    const code = line.charCodeAt(i);
    if (code < 0x20 || code > 0x2f) break;
    i += 1;
  }
  const final = line.charCodeAt(i);
  return final >= 0x30 && final <= 0x7e ? i + 1 : start;
}

/**
 * Remove terminal presentation and control sequences from a log line.
 *
 * The parser handles both seven-bit ESC forms and eight-bit C1 forms,
 * including CSI styling, OSC hyperlinks, and DCS/SOS/PM/APC control strings.
 * TAB and LF remain available for formatted records such as stack traces.
 * Unterminated terminal strings consume the remainder instead of leaking their
 * invisible payload into persisted or downloaded logs.
 */
export function sanitizeLogLine(line: string): string {
  let plain = '';
  for (let i = 0; i < line.length;) {
    const code = line.charCodeAt(i);

    if (code === ESC) {
      i = skipEscSequence(line, i + 1);
      continue;
    }
    if (code === C1_CSI) {
      i = skipCsi(line, i + 1);
      continue;
    }
    if (code === C1_OSC || C1_STRING_STARTERS.has(code)) {
      i = skipControlString(line, i + 1, code === C1_OSC);
      continue;
    }
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a) || (code >= 0x7f && code <= 0x9f)) {
      i += 1;
      continue;
    }

    plain += line[i];
    i += 1;
  }
  return plain;
}
