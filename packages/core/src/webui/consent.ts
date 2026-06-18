import { createLogger } from '@snowluma/common/logger';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const log = createLogger('WebUI.Consent');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CONFIG_DIR = 'config';
const CONSENT_CONFIG_PATH = path.join(CONFIG_DIR, 'consent.json');

// The two legal documents shown at the consent gate. Source of truth is the
// repo-root markdown; the build copies them next to the bundle (dist/) so the
// same lookup works in a packaged deploy. See vite.config.ts cp targets.
const AGREEMENT_FILES = [
  { id: 'eula' as const, file: 'EULA.md' },
  { id: 'privacy' as const, file: 'PRIVACY.md' },
];

export interface AgreementDoc {
  id: 'eula' | 'privacy';
  /** First markdown `# ` heading, for the tab/section title. */
  title: string;
  /** Declared "Version: x" from the doc — display only, NOT the consent key. */
  declaredVersion: string;
  /** Declared effective date (YYYY-MM-DD) — display only. */
  effectiveDate: string;
  /** Full markdown body the frontend renders. */
  text: string;
}

export interface ConsentRecord {
  /** The content-hash agreements version that was accepted. */
  version: string;
  /** ISO timestamp of acceptance. */
  acceptedAt: string;
}

export interface AgreementsPayload {
  /** Content-hash version of the current agreement set. */
  version: string;
  /**
   * True when the operator must (re-)accept: the agreements carry real text
   * AND the stored consent version differs from the current one. A missing or
   * unreadable agreement set fails OPEN (no gate) so a broken bundle can never
   * lock the admin out of their own panel.
   */
  consentRequired: boolean;
  documents: AgreementDoc[];
}

// ── Agreement loading (pure-ish; file read + parse, cached) ─────────────────

/**
 * Resolve an agreement file across the dev and packaged layouts. In dev the
 * server runs from source (`__dirname` = packages/core/src/webui); in a build
 * it is the single bundled dist/index.mjs (`__dirname` = dist/) with the docs
 * copied alongside. cwd is not reliable (dev cwd = packages/core, prod = repo
 * root or dist/), so we probe a handful of candidates and take the first hit.
 */
function resolveAgreementFile(file: string): string | null {
  const candidates = [
    path.join(__dirname, file), // packaged: dist/<file>
    path.resolve(__dirname, '..', '..', '..', '..', file), // dev tsx: repoRoot/<file>
    path.resolve(process.cwd(), file), // started from repo root
    path.resolve(process.cwd(), '..', '..', file), // dev cwd = packages/core
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* unreadable candidate, try next */
    }
  }
  return null;
}

/** Extract title / declared version / effective date from a doc body. */
export function parseAgreementMeta(text: string): {
  title: string;
  declaredVersion: string;
  effectiveDate: string;
} {
  const title = text.match(/^#\s+(.+?)\s*$/m)?.[1]?.trim() ?? '';
  // Matches both "Version: 1.0" / "版本 / Version:** 1.0" style lines.
  const declaredVersion =
    text.match(/(?:Version|版本)[^\n0-9]*([0-9][0-9A-Za-z.\-]*)/)?.[1]?.trim() ?? '';
  const effectiveDate =
    text.match(/(?:Effective date|生效日期)[^\n0-9]*(\d{4}-\d{2}-\d{2})/)?.[1] ?? '';
  return { title, declaredVersion, effectiveDate };
}

/**
 * Canonical agreements version = short sha256 over each doc's id + body.
 * Deliberately content-derived, NOT app-version-derived: it stays stable when
 * only the app is upgraded (so a one-time consent survives across versions),
 * and changes the moment any agreement's TEXT changes (forcing re-consent).
 */
export function computeAgreementsVersion(docs: { id: string; text: string }[]): string {
  const hash = createHash('sha256');
  for (const doc of docs) {
    hash.update(doc.id);
    hash.update('\0');
    hash.update(doc.text);
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}

let cache: { docs: AgreementDoc[]; version: string } | null = null;

/** Load + parse both agreements and compute the version. Cached per process. */
export function loadAgreements(): { docs: AgreementDoc[]; version: string } {
  if (cache) return cache;
  const docs: AgreementDoc[] = AGREEMENT_FILES.map(({ id, file }) => {
    const resolved = resolveAgreementFile(file);
    let text = '';
    if (resolved) {
      try {
        text = fs.readFileSync(resolved, 'utf8');
      } catch (err) {
        log.warn('failed to read %s: %s', file, err instanceof Error ? err.message : String(err));
      }
    } else {
      log.warn('agreement file not found (looked for %s near the bundle and repo root)', file);
    }
    const meta = parseAgreementMeta(text);
    return { id, title: meta.title, declaredVersion: meta.declaredVersion, effectiveDate: meta.effectiveDate, text };
  });
  cache = { docs, version: computeAgreementsVersion(docs) };
  return cache;
}

// ── Consent persistence (config/consent.json, atomic) ───────────────────────

function ensureConfigDir(): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

function isConsentRecord(value: unknown): value is ConsentRecord {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.version === 'string' && v.version.length > 0 && typeof v.acceptedAt === 'string';
}

export function loadConsentRecord(): ConsentRecord | null {
  try {
    if (!fs.existsSync(CONSENT_CONFIG_PATH)) return null;
    const parsed = JSON.parse(fs.readFileSync(CONSENT_CONFIG_PATH, 'utf8')) as unknown;
    return isConsentRecord(parsed) ? parsed : null;
  } catch (err) {
    log.warn('consent.json unreadable, treating as no consent: %s', err instanceof Error ? err.message : String(err));
    return null;
  }
}

function atomicWrite(record: ConsentRecord): void {
  ensureConfigDir();
  const tmp = CONSENT_CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2), { encoding: 'utf8' });
  fs.renameSync(tmp, CONSENT_CONFIG_PATH);
}

/** Persist that the operator accepted `version`. Returns the stored record. */
export function recordConsent(version: string): ConsentRecord {
  const record: ConsentRecord = { version, acceptedAt: new Date().toISOString() };
  atomicWrite(record);
  return record;
}

/** True when the agreements carry real text and the stored consent is stale. */
export function isConsentRequired(): boolean {
  const { docs, version } = loadAgreements();
  const hasContent = docs.some((d) => d.text.trim().length > 0);
  if (!hasContent) return false; // fail open: never brick the panel on a broken bundle
  return loadConsentRecord()?.version !== version;
}

/** Public payload for GET /api/agreements (texts + version + consentRequired). */
export function getAgreementsPayload(): AgreementsPayload {
  const { docs, version } = loadAgreements();
  return { version, consentRequired: isConsentRequired(), documents: docs };
}
