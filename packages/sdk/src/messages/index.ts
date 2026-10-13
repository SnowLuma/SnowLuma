import { segments } from './segments';

export { MessageChain } from './chain';
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
} from './chain';
export { escapeCqParam, escapeCqText } from './cq-format';
export { fromCQString, parseSegments, toCQString } from './cq';
export { segments };

export const message = {
    ...segments,
};
