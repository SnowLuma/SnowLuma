import { describe, expect, it } from 'vitest';
import {
  appendEvents,
  ingestTemp,
  lineSeverity,
  publicLine,
  trimMirror,
} from '../src/native-stage-sync';

const VERSION = '1.14.22';
const EVENT = 'a'.repeat(64);
const infoLine = `2026-10-09T00:00:00Z 42 1 0 ${EVENT}`;
const failLine = `2026-10-09T00:00:01Z 42 1 1 ${EVENT} ${'b'.repeat(16)}=7`;

describe('native stage sync', () => {
  it('keeps a version marker and copies the record without extra wording', () => {
    const mirror = appendEvents('', VERSION, [infoLine, failLine]);
    expect(mirror.startsWith(`v${VERSION}\n`)).toBe(true);
    expect(mirror).toContain(infoLine);
    expect(mirror).toContain(failLine);
    const shown = [publicLine(VERSION, infoLine), publicLine(VERSION, failLine)].join('\n');
    expect(shown).toBe(`${VERSION} ${infoLine}\n${VERSION} ${failLine}`);
  });

  it('opens a new version section without dropping the previous marker', () => {
    const first = appendEvents('', '1.14.22', [infoLine]);
    const second = appendEvents(first, '1.14.23', [failLine]);
    expect(second).toContain('v1.14.22\n');
    expect(second).toContain('v1.14.23\n');
    expect(second.indexOf('v1.14.22')).toBeLessThan(second.indexOf(infoLine));
    expect(second.indexOf('v1.14.23')).toBeLessThan(second.indexOf(failLine));
  });

  it('drops the oldest record first and keeps the version marker', () => {
    const long = `2026-10-09T00:00:00Z 1 1 0 ${'c'.repeat(64)} ${'d'.repeat(40)}`;
    let mirror = appendEvents('', VERSION, [long, long, long], 80);
    mirror = trimMirror(mirror, 80);
    expect(mirror).toContain(`v${VERSION}`);
    expect(mirror.split('\n').filter((line) => line.startsWith('2026')).length).toBeLessThan(3);
  });

  it('treats severity 1 as a failure and ignores a missing file', () => {
    expect(lineSeverity(failLine)).toBe('error');
    expect(lineSeverity(infoLine)).toBe('info');
    const ingested = ingestTemp({
      tempText: `${infoLine}\n${failLine}\npartial`,
      offset: 0,
      mirror: '',
      version: VERSION,
    });
    expect(ingested.lines).toEqual([infoLine, failLine]);
    expect(ingested.mirror).toContain(`v${VERSION}\n`);
    expect(ingested.offset).toBe(`${infoLine}\n${failLine}\n`.length);
    const missing = ingestTemp({
      tempText: '',
      offset: 4,
      mirror: 'keep',
      version: VERSION,
      missing: true,
    });
    expect(missing.mirror).toBe('keep');
    expect(missing.lines).toEqual([]);
    expect(missing.errorCode).toBeUndefined();
  });
});
