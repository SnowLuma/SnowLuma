import type { LogEntry } from '@snowluma/common/logger';

export interface FullTraceExportMetadata {
  version: string;
  operatingSystem: string;
  architecture: string;
  nodeVersion: string;
  logLevel: LogEntry['level'];
  exportedAt: string;
}

const PRIVACY_WARNING = 'WARNING: This export may contain unredacted private data and credentials. Sanitize it before submission.';

export interface FullTraceDownload {
  body: string;
  headers: {
    'Content-Type': string;
    'Content-Disposition': string;
    'Cache-Control': string;
  };
}

export function buildFullTraceDownload(
  entries: readonly LogEntry[],
  metadata: FullTraceExportMetadata,
): FullTraceDownload {
  const timestamp = metadata.exportedAt
    .slice(0, 19)
    .replace(/[:.]/g, '-');
  return {
    body: formatFullTraceExport(entries, metadata),
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="snowluma-trace-${timestamp}.log"`,
      'Cache-Control': 'no-store',
    },
  };
}

export function formatFullTraceExport(
  entries: readonly LogEntry[],
  metadata: FullTraceExportMetadata,
): string {
  const lines = [
    'SnowLuma full TRACE export',
    '==========================',
    `SnowLuma version: ${metadata.version}`,
    `Operating system: ${metadata.operatingSystem}`,
    `Architecture: ${metadata.architecture}`,
    `Node.js version: ${metadata.nodeVersion}`,
    `Current log level: ${metadata.logLevel.toUpperCase()}`,
    `Export time: ${metadata.exportedAt}`,
    `Retained records: ${entries.length}`,
    '',
    PRIVACY_WARNING,
    'This is a snapshot of the normal and TRACE records still retained in memory; records already evicted cannot be recovered.',
    '',
    'Logs',
    '----',
  ];

  if (entries.length === 0) {
    lines.push('(No log records are currently retained.)');
  } else {
    lines.push(...entries.map((entry) => entry.line));
  }

  return `${lines.join('\n')}\n`;
}
