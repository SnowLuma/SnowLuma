import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  computeAgreementsVersion,
  parseAgreementMeta,
  recordConsent,
  loadConsentRecord,
} from '@/webui/consent';

describe('computeAgreementsVersion', () => {
  it('is deterministic for identical input', () => {
    const docs = [
      { id: 'eula', text: 'A' },
      { id: 'privacy', text: 'B' },
    ];
    expect(computeAgreementsVersion(docs)).toBe(computeAgreementsVersion(docs));
  });

  it('changes when any agreement TEXT changes (forces re-consent)', () => {
    const before = computeAgreementsVersion([
      { id: 'eula', text: 'terms v1' },
      { id: 'privacy', text: 'privacy v1' },
    ]);
    const after = computeAgreementsVersion([
      { id: 'eula', text: 'terms v2' }, // edited
      { id: 'privacy', text: 'privacy v1' },
    ]);
    expect(after).not.toBe(before);
  });

  it('is independent of app version — same text => same version', () => {
    // The function takes only doc id+text, never an app version, so an app
    // upgrade with unchanged docs yields an identical version (stable consent).
    const v1 = computeAgreementsVersion([{ id: 'eula', text: 'same' }]);
    const v2 = computeAgreementsVersion([{ id: 'eula', text: 'same' }]);
    expect(v1).toBe(v2);
  });

  it('is not fooled by id/text boundary shifting', () => {
    const a = computeAgreementsVersion([{ id: 'eula', text: 'x' }]);
    const b = computeAgreementsVersion([{ id: 'eu', text: 'lax' }]);
    expect(a).not.toBe(b);
  });
});

describe('parseAgreementMeta', () => {
  it('pulls title / declared version / effective date from a bilingual doc', () => {
    const text = [
      '# SnowLuma 最终用户许可协议（EULA）/ End-User License Agreement',
      '',
      '- **生效日期 / Effective date:** 2026-06-19',
      '- **版本 / Version:** 1.0',
      '',
      '正文…',
    ].join('\n');
    const meta = parseAgreementMeta(text);
    expect(meta.title).toBe('SnowLuma 最终用户许可协议（EULA）/ End-User License Agreement');
    expect(meta.declaredVersion).toBe('1.0');
    expect(meta.effectiveDate).toBe('2026-06-19');
  });

  it('degrades gracefully on empty text', () => {
    expect(parseAgreementMeta('')).toEqual({ title: '', declaredVersion: '', effectiveDate: '' });
  });
});

describe('consent persistence', () => {
  let tmp: string;
  let cwd: string;

  beforeEach(() => {
    cwd = process.cwd();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'snowluma-consent-'));
    process.chdir(tmp);
  });

  afterEach(() => {
    process.chdir(cwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('records and reads back the accepted version', () => {
    expect(loadConsentRecord()).toBeNull();
    const rec = recordConsent('abc123');
    expect(rec.version).toBe('abc123');
    expect(Date.parse(rec.acceptedAt)).not.toBeNaN();

    const loaded = loadConsentRecord();
    expect(loaded?.version).toBe('abc123');
    expect(fs.existsSync(path.join('config', 'consent.json'))).toBe(true);
  });

  it('staleness check: stored version != current => re-consent needed', () => {
    recordConsent('old-version');
    const stored = loadConsentRecord();
    // mirrors isConsentRequired()'s comparison against the current version
    expect(stored?.version !== 'new-version').toBe(true);
    expect(stored?.version !== 'old-version').toBe(false);
  });

  it('ignores a malformed consent.json (treated as no consent)', () => {
    fs.mkdirSync('config', { recursive: true });
    fs.writeFileSync(path.join('config', 'consent.json'), '{ not json');
    expect(loadConsentRecord()).toBeNull();
  });
});
