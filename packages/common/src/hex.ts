export function toHex(data: Uint8Array | Buffer): string {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('hex');
}

export function toHexUpper(data: Uint8Array | Buffer): string {
    return toHex(data).toUpperCase();
}

export function hexPreview(data: Uint8Array | Buffer, maxBytes = 64): string {
    const limit = Math.max(0, Math.min(maxBytes, data.length));
    const head = toHex(data.subarray(0, limit));
    return data.length > limit ? `${head}...` : head;
}

export function fromHex(hex: string): Buffer {
    if (hex.length % 2 !== 0) {
        throw new Error('Invalid hex string length');
    }

    const buf = Buffer.alloc(hex.length / 2);

    for (let i = 0; i < buf.length; i++) {
        buf[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
    }

    return buf;
}
