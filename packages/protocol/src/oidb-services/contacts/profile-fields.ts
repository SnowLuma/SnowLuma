export interface BirthdayParts {
    year: number;
    month: number;
    day: number;
}

/** QQ property 20031: big-endian uint16 year, uint8 month, uint8 day. */
export function parseBirthday(value: Uint8Array | undefined): BirthdayParts | undefined {
    if (value?.length !== 4) {
        return undefined;
    }

    const year = value[0]! * 256 + value[1]!;
    const month = value[2]!;
    const day = value[3]!;
    // A hidden year is encoded as 0; use a leap year to validate its month/day.
    const validationYear = year || 2000;
    const date = new Date(0);
    date.setUTCHours(0, 0, 0, 0);
    date.setUTCFullYear(validationYear, month - 1, day);

    if (
        year > 9999 ||
        month < 1 ||
        month > 12 ||
        day < 1 ||
        date.getUTCFullYear() !== validationYear ||
        date.getUTCMonth() + 1 !== month ||
        date.getUTCDate() !== day
    ) {
        return undefined;
    }

    return { year, month, day };
}
