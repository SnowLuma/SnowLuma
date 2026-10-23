import type { OneBotMessageEvent } from '../types/index.js';
import type { CommandMatch, CommandOptions } from './types.js';

export function matchCommand(
    event: OneBotMessageEvent,
    command: string | RegExp,
    options: CommandOptions = {},
): CommandMatch | null {
    const trim = options.trim ?? true;
    const raw = trim ? event.raw_message.trim() : event.raw_message;
    const prefixes = normalizePrefixes(options.prefixes ?? '/');

    for (const prefix of prefixes) {
        if (prefix && !raw.startsWith(prefix)) {
            continue;
        }

        const text = prefix ? raw.slice(prefix.length).trimStart() : raw;

        if (!text) {
            continue;
        }

        if (command instanceof RegExp) {
            const match = text.match(command);

            if (!match || match.index !== 0) {
                continue;
            }

            const matchedText = match[0] ?? '';
            const rest = text.slice(matchedText.length).trim();
            return {
                command: matchedText,
                text,
                args: rest ? rest.split(/\s+/) : [],
                rest,
                prefix,
                match,
            };
        }

        const [head = '', ...args] = text.split(/\s+/);
        const matches = options.caseSensitive
            ? head === command
            : head.toLowerCase() === command.toLowerCase();

        if (!matches) {
            continue;
        }

        return {
            command: head,
            text,
            args,
            rest: text.slice(head.length).trim(),
            prefix,
            match: null,
        };
    }

    return null;
}

function normalizePrefixes(prefixes: string | string[]): string[] {
    return Array.isArray(prefixes) ? prefixes : [prefixes];
}
