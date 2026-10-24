export function computeTagBytes(fieldNumber: number, wireType: number): number[] {
    let value = ((fieldNumber << 3) | wireType) >>> 0;
    const bytes: number[] = [];

    while (value > 0x7f) {
        bytes.push((value & 0x7f) | 0x80);
        value >>>= 7;
    }

    bytes.push(value & 0x7f);
    return bytes;
}

export function writeTag(fieldNumber: number, wireType: number, ind: string): string {
    return computeTagBytes(fieldNumber, wireType)
        .map((byte) => `${ind}buf[offset++] = ${byte};`)
        .join('\n');
}

export function varintSize(varName: string, ind: string, signed = false): string {
    const negativeSize = signed ? `${varName} < 0 ? 10 : ` : '';
    return `${ind}size += ${negativeSize}${varName} < 0x80 ? 1 : ${varName} < 0x4000 ? 2 : ${varName} < 0x200000 ? 3 : ${varName} < 0x10000000 ? 4 : 5;`;
}

export function writeVarint(expr: string, ind: string, signed = false): string {
    return [
        `${ind}let _v = ${expr};`,
        ...(signed
            ? [
                  `${ind}if (_v < 0) {`,
                  `${ind}  offset = __writeVarint64(buf, offset, BigInt.asUintN(64, BigInt(_v)));`,
              ]
            : []),
        `${ind}${signed ? '} else if' : 'if'} (_v < 0x80) {`,
        `${ind}  buf[offset++] = _v;`,
        `${ind}} else if (_v < 0x4000) {`,
        `${ind}  buf[offset++] = (_v & 0x7f) | 0x80;`,
        `${ind}  buf[offset++] = _v >>> 7;`,
        `${ind}} else if (_v < 0x200000) {`,
        `${ind}  buf[offset++] = (_v & 0x7f) | 0x80;`,
        `${ind}  buf[offset++] = ((_v >>> 7) & 0x7f) | 0x80;`,
        `${ind}  buf[offset++] = _v >>> 14;`,
        `${ind}} else if (_v < 0x10000000) {`,
        `${ind}  buf[offset++] = (_v & 0x7f) | 0x80;`,
        `${ind}  buf[offset++] = ((_v >>> 7) & 0x7f) | 0x80;`,
        `${ind}  buf[offset++] = ((_v >>> 14) & 0x7f) | 0x80;`,
        `${ind}  buf[offset++] = _v >>> 21;`,
        `${ind}} else {`,
        `${ind}  buf[offset++] = (_v & 0x7f) | 0x80;`,
        `${ind}  buf[offset++] = ((_v >>> 7) & 0x7f) | 0x80;`,
        `${ind}  buf[offset++] = ((_v >>> 14) & 0x7f) | 0x80;`,
        `${ind}  buf[offset++] = ((_v >>> 21) & 0x7f) | 0x80;`,
        `${ind}  buf[offset++] = _v >>> 28;`,
        `${ind}}`,
    ].join('\n');
}
