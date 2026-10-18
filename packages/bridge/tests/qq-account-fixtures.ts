/**
 * Encryption helpers for the account-detection tests.
 *
 * The shipped code only decrypts, so producing an encrypted fixture means
 * mirroring SQLCipher's page layout here: `[client header][page 1]…` with each
 * page ending in `IV || page HMAC`, and a `-wal` whose frame header stays
 * plaintext while the page inside it is encrypted.
 */

import { createCipheriv, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import type { KdfHmacAlgorithm, PageHmacAlgorithm } from '../src/qq-account/sqlcipher';

export interface FixtureAlgorithm {
    pageHmac: PageHmacAlgorithm;
    kdfHmac: KdfHmacAlgorithm;
}

export const FIXTURE_PASSPHRASE = 'BD156D6710D54D8782F4';
export const FIXTURE_PAGE_SIZE = 4096;
export const FIXTURE_HEADER_SIZE = 1024;
export const FIXTURE_WAL_HEADER_SIZE = 32;
export const FIXTURE_WAL_FRAME_HEADER_SIZE = 24;

const DIGEST_BYTES: Record<PageHmacAlgorithm, number> = {
    none: 0,
    sha1: 20,
    sha256: 32,
    sha512: 64,
};

const KDF_ITERATIONS = 4000;
const HMAC_KEY_ITERATIONS = 2;
const HMAC_SALT_MASK = 0x3a;

export function reserveBytes(algorithm: FixtureAlgorithm): number {
    return Math.ceil((16 + DIGEST_BYTES[algorithm.pageHmac]) / 16) * 16;
}

/** Encrypt a plaintext SQLite image the way QQ NT stores it. */
export function encryptImage(
    plain: Buffer,
    algorithm: FixtureAlgorithm,
    passphrase = FIXTURE_PASSPHRASE,
    salt = randomBytes(16),
): Buffer {
    const pageCount = plain.length / FIXTURE_PAGE_SIZE;
    const key = pbkdf2Sync(passphrase, salt, KDF_ITERATIONS, 32, algorithm.kdfHmac);
    const output = Buffer.alloc(FIXTURE_HEADER_SIZE + plain.length);

    for (let index = 0; index < pageCount; index++) {
        const pageNumber = index + 1;
        const skip = pageNumber === 1 ? 16 : 0;
        const body = plain.subarray(
            index * FIXTURE_PAGE_SIZE + skip,
            (index + 1) * FIXTURE_PAGE_SIZE,
        );

        if (pageNumber === 1) {
            // Page 1 stores the KDF salt where SQLite keeps its magic.
            salt.copy(output, FIXTURE_HEADER_SIZE);
        }

        encryptPageInto(
            output,
            FIXTURE_HEADER_SIZE + index * FIXTURE_PAGE_SIZE,
            body,
            pageNumber,
            key,
            salt,
            algorithm,
        );
    }

    return output;
}

/** Encrypt the pages of a real (plaintext) WAL, recomputing the frame checksums. */
export function encryptWal(
    plainWal: Buffer,
    encryptedImage: Buffer,
    algorithm: FixtureAlgorithm,
    passphrase = FIXTURE_PASSPHRASE,
): Buffer {
    const salt = encryptedImage.subarray(FIXTURE_HEADER_SIZE, FIXTURE_HEADER_SIZE + 16);
    const key = pbkdf2Sync(passphrase, salt, KDF_ITERATIONS, 32, algorithm.kdfHmac);
    const frameSize = FIXTURE_WAL_FRAME_HEADER_SIZE + FIXTURE_PAGE_SIZE;
    const output = Buffer.alloc(plainWal.length);
    plainWal.copy(output, 0, 0, FIXTURE_WAL_HEADER_SIZE);

    let running = walChecksum([0, 0], [output.subarray(0, FIXTURE_WAL_HEADER_SIZE - 8)], true);

    for (
        let offset = FIXTURE_WAL_HEADER_SIZE;
        offset + frameSize <= plainWal.length;
        offset += frameSize
    ) {
        const frameHeader = plainWal.subarray(offset, offset + FIXTURE_WAL_FRAME_HEADER_SIZE);
        const pageNumber = frameHeader.readUInt32BE(0);
        const skip = pageNumber === 1 ? 16 : 0;
        const page = plainWal.subarray(offset + FIXTURE_WAL_FRAME_HEADER_SIZE, offset + frameSize);
        encryptPageInto(
            output,
            offset + FIXTURE_WAL_FRAME_HEADER_SIZE,
            page.subarray(skip),
            pageNumber,
            key,
            salt,
            algorithm,
        );

        const stored = output.subarray(offset, offset + FIXTURE_WAL_FRAME_HEADER_SIZE);
        frameHeader.copy(stored, 0, 0, 8);
        running = walChecksum(
            running,
            [
                stored.subarray(0, 8),
                output.subarray(offset + FIXTURE_WAL_FRAME_HEADER_SIZE, offset + frameSize),
            ],
            true,
        );
        stored.writeUInt32BE(running[0], 16);
        stored.writeUInt32BE(running[1], 20);
    }

    return output;
}

/**
 * SQLite's rolling WAL checksum, as the fixture needs it to rebuild frame
 * checksums — and to prove the shipped implementation agrees with what SQLite
 * itself wrote in a real `-wal`.
 */
export function walChecksum(
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

function encryptPageInto(
    output: Buffer,
    pageOffset: number,
    body: Buffer,
    pageNumber: number,
    key: Buffer,
    salt: Buffer,
    algorithm: FixtureAlgorithm,
): void {
    // Page 1 stores the KDF salt where SQLite keeps its magic, so its ciphertext
    // starts one salt past the page boundary.
    const offset = pageOffset + (pageNumber === 1 ? 16 : 0);
    const reserve = reserveBytes(algorithm);
    const cipherLength = body.length - reserve;
    const iv = randomBytes(16);
    const cipher = createCipheriv('aes-256-cbc', key, iv);
    cipher.setAutoPadding(false);
    const ciphertext = Buffer.concat([
        cipher.update(body.subarray(0, cipherLength)),
        cipher.final(),
    ]);
    ciphertext.copy(output, offset);
    iv.copy(output, offset + cipherLength);

    const digestBytes = DIGEST_BYTES[algorithm.pageHmac];

    if (digestBytes === 0) {
        return;
    }

    const hmacSalt = Buffer.from(salt.map((byte) => byte ^ HMAC_SALT_MASK));
    const hmacKey = pbkdf2Sync(key, hmacSalt, HMAC_KEY_ITERATIONS, 32, algorithm.kdfHmac);
    const pageNumberBytes = Buffer.alloc(4);
    pageNumberBytes.writeUInt32LE(pageNumber);
    const digest = createHmac(algorithm.pageHmac, hmacKey)
        .update(ciphertext)
        .update(iv)
        .update(pageNumberBytes)
        .digest();
    digest.copy(output, offset + cipherLength + 16);
}
