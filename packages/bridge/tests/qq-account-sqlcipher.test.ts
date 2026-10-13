import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SqliteDatabase } from '@snowluma/sqlite';
import {
    DATABASE_HEADER_SIZE,
    decryptDatabase,
    detectAlgorithm,
    type SqlcipherAlgorithm,
} from '../src/qq-account/sqlcipher';
import {
    FIXTURE_HEADER_SIZE,
    FIXTURE_PAGE_SIZE,
    FIXTURE_PASSPHRASE,
    FIXTURE_WAL_FRAME_HEADER_SIZE,
    FIXTURE_WAL_HEADER_SIZE,
    encryptImage,
    encryptWal,
    reserveBytes,
    walChecksum,
    type FixtureAlgorithm,
} from './qq-account-fixtures';

const SHA1_SHA512: FixtureAlgorithm = { pageHmac: 'sha1', kdfHmac: 'sha512' };

/**
 * Reserved space SQLite is told about for an encrypted database: room for the
 * IV plus the largest page digest. SQLCipher's own reserve always fits inside
 * it, which is why the tail of every page is disposable.
 */
const HEADER_RESERVED_BYTES = 80;

/** Offset of one frame in a `-wal` buffer. */
function frameOffset(index: number): number {
    return FIXTURE_WAL_HEADER_SIZE + index * (FIXTURE_WAL_FRAME_HEADER_SIZE + FIXTURE_PAGE_SIZE);
}

/** Last frame index a merge may have applied, or -1 when nothing was committed. */
function lastCommitFrame(wal: Buffer, maxFrameIndex = frameCount(wal) - 1): number {
    let last = -1;

    for (let index = 0; index <= maxFrameIndex; index++) {
        if (wal.readUInt32BE(frameOffset(index) + 4) !== 0) {
            last = index;
        }
    }

    return last;
}

function frameCount(wal: Buffer): number {
    const frameSize = FIXTURE_WAL_FRAME_HEADER_SIZE + FIXTURE_PAGE_SIZE;
    return Math.floor((wal.length - FIXTURE_WAL_HEADER_SIZE) / frameSize);
}

/** Frames up to and including the last commit, i.e. what a merge should apply. */
function committedFrames(wal: Buffer, maxFrameIndex?: number): number {
    return lastCommitFrame(wal, maxFrameIndex) + 1;
}

/** Database size the last applicable commit declares. */
function lastCommitSize(wal: Buffer, maxFrameIndex?: number): number {
    return wal.readUInt32BE(frameOffset(lastCommitFrame(wal, maxFrameIndex)) + 4);
}

/** Page content as the last applicable commit left it, keyed by page number. */
function committedPages(wal: Buffer, maxFrameIndex?: number): Map<number, Buffer> {
    const pages = new Map<number, Buffer>();
    const last = lastCommitFrame(wal, maxFrameIndex);
    const size = lastCommitSize(wal, maxFrameIndex);

    for (let index = 0; index <= last; index++) {
        const pageNumber = wal.readUInt32BE(frameOffset(index));

        if (pageNumber >= 1 && pageNumber <= size) {
            pages.set(
                pageNumber,
                wal.subarray(
                    frameOffset(index) + FIXTURE_WAL_FRAME_HEADER_SIZE,
                    frameOffset(index + 1),
                ),
            );
        }
    }

    return pages;
}

/** Compare one merged page against the page a frame carried. */
function expectPageMatches(
    merged: Buffer,
    expectedPage: Buffer,
    pageNumber: number,
    algorithm: FixtureAlgorithm,
): void {
    const reserve = reserveBytes(algorithm);
    const start = (pageNumber - 1) * FIXTURE_PAGE_SIZE;
    // Page 1's SQLite header carries the fields the merge keeps consistent with
    // the assembled image (change counter, page count, journal mode), so only the
    // page body is compared there.
    const bodyStart = pageNumber === 1 ? 100 : 0;
    expect(merged.subarray(start + bodyStart, start + FIXTURE_PAGE_SIZE - reserve)).toEqual(
        expectedPage.subarray(bodyStart, FIXTURE_PAGE_SIZE - reserve),
    );
    expect(
        merged
            .subarray(start + FIXTURE_PAGE_SIZE - reserve, start + FIXTURE_PAGE_SIZE)
            .equals(Buffer.alloc(reserve)),
    ).toBe(true);
}

/** A plaintext image with the header fields the merge keeps consistent. */
function plaintextImage(pageCount: number, marker = 0): Buffer {
    const image = Buffer.alloc(pageCount * FIXTURE_PAGE_SIZE);

    for (let page = 0; page < pageCount; page++) {
        for (let offset = 0; offset < FIXTURE_PAGE_SIZE - HEADER_RESERVED_BYTES; offset++) {
            image[page * FIXTURE_PAGE_SIZE + offset] = (page * 31 + offset + marker) % 251;
        }
    }

    image.write('SQLite format 3\0', 0, 'latin1');
    image.writeUInt16BE(FIXTURE_PAGE_SIZE, 16);
    image[18] = 1;
    image[19] = 1;
    image[20] = HEADER_RESERVED_BYTES;
    image[21] = 64;
    image[22] = 32;
    image[23] = 32;
    image.writeUInt32BE(7, 24);
    image.writeUInt32BE(pageCount, 28);
    image.writeUInt32BE(7, 92);
    return image;
}

/** A real SQLite database in WAL mode, plus the sidecar SQLite wrote for it. */
async function realWalDatabase(
    directory: string,
    inserts: string[][],
): Promise<{ image: Buffer; wal: Buffer; db: SqliteDatabase }> {
    const file = path.join(directory, 'source.db');
    const db = new SqliteDatabase(file);
    await db.exec('PRAGMA wal_autocheckpoint = 0');
    await db.exec('CREATE TABLE t(value TEXT)');

    for (const [value] of inserts) {
        await db.prepare('INSERT INTO t VALUES (?)').run(value);
    }

    return { image: await readFile(file), wal: await readFile(`${file}-wal`), db };
}

describe('SQLCipher page decryption', () => {
    it('round-trips a page image and normalizes the header', () => {
        const plain = plaintextImage(3);
        plain[18] = 2; // stored as a WAL-mode database, like QQ writes them
        plain[19] = 2;
        const encrypted = encryptImage(plain, SHA1_SHA512);

        expect(detectAlgorithm(encrypted, FIXTURE_PASSPHRASE)).toEqual(SHA1_SHA512);

        const decrypted = decryptDatabase(encrypted, null, FIXTURE_PASSPHRASE, SHA1_SHA512);
        expect(decrypted).not.toBeNull();

        const expected = Buffer.from(plain);
        expected[18] = 1;
        expected[19] = 1;
        expected.writeUInt32BE(3, 28);
        expected.writeUInt32BE(7, 92);
        expect(decrypted!.image.equals(expected)).toBe(true);
        expect(decrypted!.walFrames).toBe(0);
    });

    it('probes the algorithm pair instead of assuming one', () => {
        const plain = plaintextImage(2);

        for (const algorithm of [
            { pageHmac: 'sha256', kdfHmac: 'sha256' },
            { pageHmac: 'sha512', kdfHmac: 'sha1' },
            { pageHmac: 'none', kdfHmac: 'sha512' },
        ] satisfies SqlcipherAlgorithm[]) {
            const encrypted = encryptImage(plain, algorithm);
            expect(detectAlgorithm(encrypted, FIXTURE_PASSPHRASE)).toEqual(algorithm);
            expect(
                decryptDatabase(encrypted, null, FIXTURE_PASSPHRASE, algorithm)!.image.equals(
                    plain,
                ),
            ).toBe(true);
        }
    });

    it('rejects a wrong passphrase and a file that is too short', () => {
        const encrypted = encryptImage(plaintextImage(2), SHA1_SHA512);
        expect(detectAlgorithm(encrypted, 'wrong-passphrase')).toBeNull();
        expect(
            detectAlgorithm(Buffer.alloc(DATABASE_HEADER_SIZE + 512), FIXTURE_PASSPHRASE),
        ).toBeNull();
        expect(decryptDatabase(Buffer.alloc(64), null, FIXTURE_PASSPHRASE, SHA1_SHA512)).toBeNull();
    });
});

describe('SQLCipher WAL folding', () => {
    it('reproduces the frame checksums SQLite itself wrote', async () => {
        const directory = await mkdtemp(path.join(os.tmpdir(), 'snowluma-wal-'));

        try {
            const { wal, db } = await realWalDatabase(directory, [['a'], ['b']]);
            const littleEndian = wal.readUInt32BE(0) === 0x377f0682;
            const frameSize = FIXTURE_WAL_FRAME_HEADER_SIZE + FIXTURE_PAGE_SIZE;
            expect((wal.length - FIXTURE_WAL_HEADER_SIZE) % frameSize).toBe(0);

            const header = walChecksum(
                [0, 0],
                [wal.subarray(0, FIXTURE_WAL_HEADER_SIZE - 8)],
                littleEndian,
            );
            expect(header).toEqual([wal.readUInt32BE(24), wal.readUInt32BE(28)]);

            let running = header;

            for (
                let offset = FIXTURE_WAL_HEADER_SIZE;
                offset + frameSize <= wal.length;
                offset += frameSize
            ) {
                const frame = wal.subarray(offset, offset + FIXTURE_WAL_FRAME_HEADER_SIZE);
                running = walChecksum(
                    running,
                    [
                        frame.subarray(0, 8),
                        wal.subarray(offset + FIXTURE_WAL_FRAME_HEADER_SIZE, offset + frameSize),
                    ],
                    littleEndian,
                );
                expect(running).toEqual([frame.readUInt32BE(16), frame.readUInt32BE(20)]);
            }

            await db.close();
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    it('folds every committed frame into the decrypted image', async () => {
        const directory = await mkdtemp(path.join(os.tmpdir(), 'snowluma-wal-'));

        try {
            const { image, wal, db } = await realWalDatabase(directory, [['a'], ['b']]);
            const encryptedImage = encryptImage(image, SHA1_SHA512);
            const encryptedWal = encryptWal(wal, encryptedImage, SHA1_SHA512);

            const decrypted = decryptDatabase(
                encryptedImage,
                encryptedWal,
                FIXTURE_PASSPHRASE,
                SHA1_SHA512,
            );
            expect(decrypted!.walFrames).toBe(committedFrames(wal));
            expect(decrypted!.image.length).toBe(lastCommitSize(wal) * FIXTURE_PAGE_SIZE);

            // Every page a committed frame carried has to arrive as it was written,
            // apart from the on-disk IV/HMAC region the encryptor owns.
            for (const [pageNumber, page] of committedPages(wal)) {
                expectPageMatches(decrypted!.image, page, pageNumber, SHA1_SHA512);
            }

            await db.close();
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    it('keeps the intact prefix of a WAL torn by a running client', async () => {
        const directory = await mkdtemp(path.join(os.tmpdir(), 'snowluma-wal-'));

        try {
            const { image, wal, db } = await realWalDatabase(directory, [['a'], ['b']]);
            const encryptedImage = encryptImage(image, SHA1_SHA512);
            const encryptedWal = encryptWal(wal, encryptedImage, SHA1_SHA512);
            const frameSize = FIXTURE_WAL_FRAME_HEADER_SIZE + FIXTURE_PAGE_SIZE;
            const frameCount = (wal.length - FIXTURE_WAL_HEADER_SIZE) / frameSize;
            // Shred the last frame's page: everything after the previous commit
            // must be dropped rather than half-applied.
            encryptedWal[encryptedWal.length - 8] ^= 0xff;

            const decrypted = decryptDatabase(
                encryptedImage,
                encryptedWal,
                FIXTURE_PASSPHRASE,
                SHA1_SHA512,
            );
            expect(decrypted).not.toBeNull();
            expect(decrypted!.walFrames).toBeLessThan(frameCount);
            // Frames up to the tear survive; the merge still stops at the last
            // commit they contain rather than applying a partial transaction.
            expect(decrypted!.walFrames).toBe(committedFrames(wal, frameCount - 2));

            // Everything the surviving commits wrote has to be in the image.
            for (const [pageNumber, page] of committedPages(wal, frameCount - 2)) {
                expectPageMatches(decrypted!.image, page, pageNumber, SHA1_SHA512);
            }

            await db.close();
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
});

describe('SQLCipher header handling', () => {
    it('keeps the client header opaque and stores the salt at the start of page 1', () => {
        const plain = plaintextImage(2);
        const encrypted = encryptImage(plain, SHA1_SHA512);
        const header = encrypted.subarray(0, FIXTURE_HEADER_SIZE);

        expect(header.equals(Buffer.alloc(FIXTURE_HEADER_SIZE))).toBe(true);
        expect(
            encrypted
                .subarray(FIXTURE_HEADER_SIZE + 16, FIXTURE_HEADER_SIZE + 48)
                .equals(plain.subarray(16, 48)),
        ).toBe(false);
    });
});
