import { describe, expect, it } from 'vitest';
import type { LogEntry } from '@snowluma/common/logger';
import { buildFullTraceDownload, formatFullTraceExport } from '../src/webui/log-export';

const metadata = {
  version: '1.12.10',
  operatingSystem: 'linux',
  architecture: 'x64',
  nodeVersion: 'v22.18.0',
  logLevel: 'trace',
  exportedAt: '2026-07-31T04:00:00.000Z',
} as const;

function entry(id: number, level: LogEntry['level'], line: string): LogEntry {
  return {
    id,
    time: `2026-07-31T04:00:0${id}.000Z`,
    level,
    scope: 'Test',
    message: line,
    line,
  };
}

describe('formatFullTraceExport', () => {
  it('includes environment metadata, privacy warning, and every retained line unchanged', () => {
    const traceLine = '04:00:02 TRACE [Packet] recvHex=00010203aabbccddeeff';
    const text = formatFullTraceExport([
      entry(1, 'info', '04:00:01 INFO [Runtime] connected'),
      entry(2, 'trace', traceLine),
      entry(3, 'warn', '04:00:03 WARN [Runtime] retrying'),
    ], metadata);

    expect(text).toContain('SnowLuma version: 1.12.10');
    expect(text).toContain('Operating system: linux');
    expect(text).toContain('Architecture: x64');
    expect(text).toContain('Node.js version: v22.18.0');
    expect(text).toContain('Current log level: TRACE');
    expect(text).toContain('Export time: 2026-07-31T04:00:00.000Z');
    expect(text).toContain('WARNING: This export may contain unredacted private data and credentials. Sanitize it before submission.');
    expect(text.indexOf('connected')).toBeLessThan(text.indexOf(traceLine));
    expect(text.indexOf(traceLine)).toBeLessThan(text.indexOf('retrying'));
    expect(text).toContain(`${traceLine}\n`);
  });

  it('builds a browser-only text download with no-store headers', () => {
    const download = buildFullTraceDownload([], metadata);

    expect(download.headers).toEqual({
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': 'attachment; filename="snowluma-trace-2026-07-31T04-00-00.log"',
      'Cache-Control': 'no-store',
    });
    expect(download.body).toContain('SnowLuma full TRACE export');
  });

  it('clearly reports an empty retained snapshot', () => {
    const text = formatFullTraceExport([], metadata);

    expect(text).toContain('Retained records: 0');
    expect(text).toContain('(No log records are currently retained.)');
    expect(text.endsWith('\n')).toBe(true);
  });
});
