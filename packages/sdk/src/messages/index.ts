import { segments } from './segments.js';

export { MessageChain } from './chain.js';
export {
    at,
    atAll,
    br,
    chain,
    contact,
    face,
    forward,
    image,
    json,
    location,
    music,
    node,
    normalizeMessage,
    poke,
    raw,
    record,
    reply,
    share,
    text,
    video,
    xml,
} from './chain.js';
export { escapeCqParam, escapeCqText } from './cq-format.js';
export { fromCQString, parseSegments, toCQString } from './cq.js';
export { quoteMessage } from './quote.js';
export { segments };

export const message = {
    ...segments,
};
