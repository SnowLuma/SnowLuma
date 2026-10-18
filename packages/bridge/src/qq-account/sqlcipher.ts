/**
 * SQLCipher v4 page decryption for QQ NT's local databases.
 *
 * QQ NT stores every database under `nt_db/` as a SQLCipher v4 stream behind a
 * 1024-byte client header:
 *
 *   [ 1024-byte client header ][ page 1 ][ page 2 ] ...
 *                               ^ KDF salt = first 16 bytes of page 1
 *
 * Each page ends with `IV (16 bytes) || page HMAC`, rounded up to the AES block
 * size; the page size is 4096 on every database QQ writes. Page 1's ciphertext
 * starts after its 16-byte salt, which replaces the plaintext "SQLite format 3"
 * magic — so the decrypted body of page 1 starts at page offset 16 and can never
 * contain that magic. A candidate key is therefore confirmed by recomputing the
 * page HMAC over the *ciphertext*, which is independent of the AES pass.
 *
 * The page-HMAC and KDF-HMAC algorithms are not fixed across client builds, so
 * they are probed per database (12 combinations) instead of assumed.
 */

import { createDecipheriv, createHmac, pbkdf2Sync } from 'node:crypto';

/** QQ NT prepends this many bytes before the SQLCipher stream. */
export const DATABASE_HEADER_SIZE = 1024;

const PAGE_SIZE = 4096;
const SALT_SIZE = 16;
const IV_SIZE = 16;
const KEY_SIZE = 32;

/** SQLCipher v4 derives the AES key with this many PBKDF2 iterations. */
const KDF_ITERATIONS = 4000;
/** The per-page HMAC key uses a fast derivation over the page salt. */
const HMAC_KEY_ITERATIONS = 2;
/** SQLCipher's HMAC salt is the page salt XOR this mask. */
const HMAC_SALT_MASK = 0x3a;

const WAL_HEADER_SIZE = 32;
const WAL_FRAME_HEADER_SIZE = 24;

const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'latin1');

export type PageHmacAlgorithm = 'none' | 'sha1' | 'sha256' | 'sha512';
export type KdfHmacAlgorithm = 'sha1' | 'sha256' | 'sha512';

/** One SQLCipher algorithm pair, as probed against a database's page 1. */
export interface SqlcipherAlgorithm {
    pageHmac: PageHmacAlgorithm;
    kdfHmac: KdfHmacAlgorithm;
}

/** Every pair to probe, in order: `cipher_use_hmac = OFF` first, then each digest. */
const PAGE_HMAC_ALGORITHMS: readonly PageHmacAlgorithm[] = ['none', 'sha1', 'sha256', 'sha512'];
const KDF_HMAC_ALGORITHMS: readonly KdfHmacAlgorithm[] = ['sha1', 'sha256', 'sha512'];

const PAGE_HMAC_DIGEST_BYTES: Record<PageHmacAlgorithm, number> = {
    none: 0,
    sha1: 20,
    sha256: 32,
    sha512: 64,
};

/** A database image decrypted from disk, with its `-wal` frames folded in. */
export interface DecryptedDatabase {
    /** A self-contained plaintext SQLite image (rollback-journal mode). */
    image: Buffer;
    /** Frames folded in from the `-wal` sidecar, 0 when there was nothing to merge. */
    walFrames: number;
}

/**
 * Probe the algorithm pair of an encrypted database.
 *
 * Returns null when the page-1 HMAC matches no combination under `passphrase`,
 * which means either the passphrase or the file layout is not what we expect.
 */
export function detectAlgorithm(image: Buffer, passphrase: string): SqlcipherAlgorithm | null {
    const pageOne = readPageOne(image);

    if (!pageOne) {
        return null;
    }

    const salt = pageOne.subarray(0, SALT_SIZE);

    for (const pageHmac of PAGE_HMAC_ALGORITHMS) {
        for (const kdfHmac of KDF_HMAC_ALGORITHMS) {
            const algorithm: SqlcipherAlgorithm = { pageHmac, kdfHmac };
            const key = deriveKey(passphrase, salt, kdfHmac);

            if (verifyPageOne(pageOne, key, algorithm)) {
                return algorithm;
            }
        }
    }

    return null;
}

/**
 * Decrypt a whole database and fold in the `-wal` sidecar when there is one.
 *
 * QQ keeps a long-lived WAL, so everything committed since the last checkpoint
 * — including an account that just signed in — lives only in the sidecar.
 * Returns null when the image cannot be decrypted.
 */
export function decryptDatabase(
    image: Buffer,
    wal: Buffer | null,
    passphrase: string,
    algorithm: SqlcipherAlgorithm,
): DecryptedDatabase | null {
    const pageOne = readPageOne(image);

    if (!pageOne) {
        return null;
    }

    const key = deriveKey(passphrase, pageOne.subarray(0, SALT_SIZE), algorithm.kdfHmac);
    const base = decryptPages(image, key, algorithm);

    if (!base) {
        return null;
    }

    const merged = applyWal(base, wal, key, algorithm);
    normalizeImage(merged.image);
    return merged;
}

/** Page 1 as stored, or null when the file is too short to hold a header + page 1. */
function readPageOne(image: Buffer): Buffer | null {
    if (image.length < DATABASE_HEADER_SIZE + PAGE_SIZE) {
        return null;
    }

    return image.subarray(DATABASE_HEADER_SIZE, DATABASE_HEADER_SIZE + PAGE_SIZE);
}

/** Per-page reserve = IV + page HMAC digest, rounded up to the AES block size. */
function reserveBytes(algorithm: SqlcipherAlgorithm): number {
    const digestBytes = PAGE_HMAC_DIGEST_BYTES[algorithm.pageHmac];
    return Math.ceil((IV_SIZE + digestBytes) / 16) * 16;
}

function deriveKey(passphrase: string, salt: Buffer, kdfHmac: KdfHmacAlgorithm): Buffer {
    return pbkdf2Sync(passphrase, salt, KDF_ITERATIONS, KEY_SIZE, kdfHmac);
}

/**
 * Confirm a candidate key against page 1.
 *
 * With the page HMAC enabled the check runs over the stored ciphertext, exactly
 * like SQLCipher's own verification. With HMAC off there is nothing to verify on
 * the ciphertext, so page 1 is decrypted and the SQLite header fields that live
 * past the salt-occupied first 16 bytes are checked instead.
 */
function verifyPageOne(pageOne: Buffer, key: Buffer, algorithm: SqlcipherAlgorithm): boolean {
    const reserve = reserveBytes(algorithm);
    const digestBytes = PAGE_HMAC_DIGEST_BYTES[algorithm.pageHmac];

    if (digestBytes === 0) {
        const body = decryptPageBody(pageOne, key, SALT_SIZE, reserve);
        return body !== null && hasSqliteHeaderFields(body);
    }

    const hmacSalt = Buffer.alloc(SALT_SIZE);

    for (let index = 0; index < SALT_SIZE; index++) {
        hmacSalt[index] = pageOne[index] ^ HMAC_SALT_MASK;
    }

    const hmacKey = pbkdf2Sync(key, hmacSalt, HMAC_KEY_ITERATIONS, KEY_SIZE, algorithm.kdfHmac);
    const bodyEnd = PAGE_SIZE - reserve;
    const pageNumber = Buffer.alloc(4);
    pageNumber.writeUInt32LE(1);
    const input = Buffer.concat([
        pageOne.subarray(SALT_SIZE, bodyEnd),
        pageOne.subarray(bodyEnd, bodyEnd + IV_SIZE),
        pageNumber,
    ]);
    const computed = createHmac(algorithm.pageHmac, hmacKey).update(input).digest();
    const stored = pageOne.subarray(bodyEnd + IV_SIZE, bodyEnd + IV_SIZE + digestBytes);
    return equalsBytes(computed, stored);
}

/** The decrypted page-1 body starts at file offset 16 (the salt replaces 0..16). */
function hasSqliteHeaderFields(body: Buffer): boolean {
    if (body.length < 8) {
        return false;
    }

    const pageSize = body.readUInt16BE(0);
    const pageSizeOk = pageSize === 1 || (pageSize >= 512 && (pageSize & (pageSize - 1)) === 0);
    return pageSizeOk && body[5] === 64 && body[6] === 32 && body[7] === 32;
}

function equalsBytes(left: Buffer, right: Buffer): boolean {
    if (left.length !== right.length) {
        return false;
    }

    let diff = 0;

    for (let index = 0; index < left.length; index++) {
        diff |= left[index]! ^ right[index]!;
    }

    return diff === 0;
}

/**
 * Decrypt every page of the main file, in place on a fresh buffer.
 *
 * `skip` drops the salt prefix of page 1; the reserve region of each page is
 * left zeroed, which is how SQLCipher lays the plaintext out.
 */
function decryptPages(image: Buffer, key: Buffer, algorithm: SqlcipherAlgorithm): Buffer | null {
    const stream = image.subarray(DATABASE_HEADER_SIZE);
    const pageCount = Math.floor(stream.length / PAGE_SIZE);

    if (pageCount === 0) {
        return null;
    }

    const reserve = reserveBytes(algorithm);
    const plain = Buffer.alloc(pageCount * PAGE_SIZE);

    for (let index = 0; index < pageCount; index++) {
        const pageNumber = index + 1;
        const page = stream.subarray(index * PAGE_SIZE, (index + 1) * PAGE_SIZE);
        const body = decryptPageBody(page, key, pageNumber === 1 ? SALT_SIZE : 0, reserve);

        if (body === null) {
            return null;
        }

        writePlaintextPage(plain, index * PAGE_SIZE, pageNumber, body);
    }

    return plain;
}

/** Decrypt one page body, or null when the page cannot hold an IV + digest. */
function decryptPageBody(page: Buffer, key: Buffer, skip: number, reserve: number): Buffer | null {
    const cipherLength = PAGE_SIZE - skip - reserve;

    if (cipherLength <= 0) {
        return null;
    }

    const ciphertext = page.subarray(skip, skip + cipherLength);
    const iv = page.subarray(skip + cipherLength, skip + cipherLength + IV_SIZE);
    const decipher = createDecipheriv('aes-256-cbc', key, iv);
    decipher.setAutoPadding(false);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Write one decrypted page into the plaintext image.
 *
 * Page 1 is special in both the main file and the WAL: its first 16 on-disk
 * bytes hold the KDF salt in place of SQLite's magic, so the magic and the
 * page-size field have to be restored. Every other page's body starts at offset
 * 0 of the page.
 */
function writePlaintextPage(image: Buffer, offset: number, pageNumber: number, body: Buffer): void {
    if (pageNumber !== 1) {
        body.copy(image, offset, 0, Math.min(body.length, PAGE_SIZE));
        return;
    }

    SQLITE_MAGIC.copy(image, offset);
    body.copy(image, offset + SALT_SIZE, 0, Math.min(body.length, PAGE_SIZE - SALT_SIZE));
    image.writeUInt16BE(PAGE_SIZE, offset + 16);
}

/**
 * Fold the `-wal` sidecar into a decrypted image and return the frame count.
 *
 * A WAL is not wrapped in SQLCipher's envelope the way the main file is: its
 * 32-byte header and every 24-byte frame header stay plaintext, and each frame
 * carries one encrypted page (page 1 keeping its salt prefix). SQLite's frame
 * checksums are computed over the frames *as stored*, i.e. over the ciphertext,
 * which is why the intact prefix is established before any decryption.
 *
 * Only frames up to the last commit are applied, and the database size recorded
 * by that commit decides how many pages the merged image has — a torn tail from
 * a running QQ therefore contributes nothing.
 */
function applyWal(
    base: Buffer,
    wal: Buffer | null,
    key: Buffer,
    algorithm: SqlcipherAlgorithm,
): DecryptedDatabase {
    const log = wal === null ? null : parseWal(wal);

    if (!log || log.frames.length === 0) {
        return { image: base, walFrames: 0 };
    }

    let lastCommit = -1;

    for (let index = 0; index < log.frames.length; index++) {
        if (log.frames[index]!.commitSize !== 0) {
            lastCommit = index;
        }
    }

    if (lastCommit < 0) {
        return { image: base, walFrames: 0 };
    }

    const pageCount = log.frames[lastCommit]!.commitSize;
    const basePageCount = base.length / PAGE_SIZE;

    // A commit can only grow the database by the pages its own log carries, so
    // anything past that bound is a corrupt frame header rather than a size.
    if (pageCount < 1 || pageCount > basePageCount + log.frames.length) {
        return { image: base, walFrames: 0 };
    }

    const merged = Buffer.alloc(pageCount * PAGE_SIZE);
    base.copy(merged, 0, 0, Math.min(base.length, merged.length));
    const reserve = reserveBytes(algorithm);

    for (let index = 0; index <= lastCommit; index++) {
        const frame = log.frames[index]!;

        if (frame.pageNumber === 0 || frame.pageNumber > pageCount) {
            continue;
        }

        const page = wal!.subarray(frame.offset, frame.offset + PAGE_SIZE);
        const body = decryptPageBody(page, key, frame.pageNumber === 1 ? SALT_SIZE : 0, reserve);

        if (body === null) {
            return { image: base, walFrames: 0 };
        }

        writePlaintextPage(merged, (frame.pageNumber - 1) * PAGE_SIZE, frame.pageNumber, body);
    }

    return { image: merged, walFrames: lastCommit + 1 };
}

interface WalFrame {
    pageNumber: number;
    /** Database size in pages recorded by a commit frame, 0 for a non-commit frame. */
    commitSize: number;
    /** Offset of the frame's page inside the `-wal` buffer. */
    offset: number;
}

interface WalLog {
    frames: WalFrame[];
    littleEndian: boolean;
}

/**
 * Validate a `-wal` buffer and collect its intact frames.
 *
 * Validation stops at the first frame whose checksum does not continue the
 * chain, mirroring SQLite's own recovery: everything after that frame is either
 * half-written or belongs to an aborted transaction.
 */
function parseWal(wal: Buffer): WalLog | null {
    if (wal.length < WAL_HEADER_SIZE + WAL_FRAME_HEADER_SIZE + PAGE_SIZE) {
        return null;
    }

    const magic = wal.readUInt32BE(0);
    const littleEndian = magic === 0x377f0682 ? true : magic === 0x377f0683 ? false : null;

    if (littleEndian === null || wal.readUInt32BE(8) !== PAGE_SIZE) {
        return null;
    }

    // The header checksum covers its first 24 bytes; magic and page size are
    // excluded from the checksummed range by that length.
    const header = walChecksum([0, 0], [wal.subarray(0, WAL_HEADER_SIZE - 8)], littleEndian);

    if (header[0] !== wal.readUInt32BE(24) || header[1] !== wal.readUInt32BE(28)) {
        return null;
    }

    const frameSize = WAL_FRAME_HEADER_SIZE + PAGE_SIZE;
    const frames: WalFrame[] = [];
    let running = header;

    for (let offset = WAL_HEADER_SIZE; offset + frameSize <= wal.length; offset += frameSize) {
        const frameHeader = wal.subarray(offset, offset + WAL_FRAME_HEADER_SIZE);
        const page = wal.subarray(offset + WAL_FRAME_HEADER_SIZE, offset + frameSize);
        running = walChecksum(running, [frameHeader.subarray(0, 8), page], littleEndian);

        if (
            running[0] !== frameHeader.readUInt32BE(16) ||
            running[1] !== frameHeader.readUInt32BE(20)
        ) {
            break;
        }

        frames.push({
            pageNumber: frameHeader.readUInt32BE(0),
            commitSize: frameHeader.readUInt32BE(4),
            offset: offset + WAL_FRAME_HEADER_SIZE,
        });
    }

    return { frames, littleEndian };
}

/**
 * SQLite's rolling WAL checksum: two 32-bit accumulators advanced over 8-byte
 * word pairs. The byte order is fixed by the WAL magic (`0x377f0682` =
 * little-endian words, `0x377f0683` = big-endian) and is unrelated to the
 * host's byte order.
 *
 * Every chunk fed in here is a multiple of 8 bytes: the header contributes 24
 * bytes, a frame its first 8 header bytes plus a whole page.
 */
function walChecksum(
    seed: [number, number],
    chunks: readonly Buffer[],
    littleEndian: boolean,
): [number, number] {
    let first = seed[0];
    let second = seed[1];

    for (const chunk of chunks) {
        for (let offset = 0; offset + 8 <= chunk.length; offset += 8) {
            const high = littleEndian ? chunk.readUInt32LE(offset) : chunk.readUInt32BE(offset);
            const low = littleEndian
                ? chunk.readUInt32LE(offset + 4)
                : chunk.readUInt32BE(offset + 4);
            first = (first + high + second) >>> 0;
            second = (second + low + first) >>> 0;
        }
    }

    return [first, second];
}

/**
 * Make the assembled image self-consistent before it is handed to SQLite.
 *
 * The merge can add or remove pages relative to the base image, and the header
 * fields that describe the database are only trusted while page 1's change
 * counter and version-valid-for agree. The write/read version bytes are reset
 * to the legacy journal so the image can be opened read-only without needing a
 * `-wal`/`-shm` pair next to it.
 */
function normalizeImage(image: Buffer): void {
    const pageCount = image.length / PAGE_SIZE;
    const changeCounter = image.readUInt32BE(24);
    image[18] = 1;
    image[19] = 1;
    image.writeUInt32BE(pageCount, 28);
    image.writeUInt32BE(changeCounter, 92);
}
