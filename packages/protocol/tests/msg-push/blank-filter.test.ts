import { describe, expect, it } from 'vitest';
import {
  classifyMessageSurvival,
  isBlankMessage,
  isC2cControlPush,
} from '../../src/msg-push/blank-filter';

const privateHead = { msgType: 166, c2cCmd: 0 };
const controlHead = { msgType: 166, c2cCmd: 75 };
const groupHead = { msgType: 82, c2cCmd: 0 };

describe('classifyMessageSurvival', () => {
  it('drops C2C control even when elements decoded', () => {
    expect(isC2cControlPush(controlHead)).toBe(true);
    expect(classifyMessageSurvival(controlHead, [{ type: 'text' }], {
      richText: { elems: [{ text: { str: 'noise' } }] },
    })).toBe('drop-control');
  });

  it('drops a genuinely empty non-control body', () => {
    expect(isBlankMessage([], { richText: { elems: [] } })).toBe(true);
    expect(classifyMessageSurvival(privateHead, [], { richText: { elems: [] } })).toBe('drop-blank');
    expect(classifyMessageSurvival(groupHead, [], { richText: { elems: [] } })).toBe('drop-blank');
  });

  it('keeps an empty decode when the body still carried content', () => {
    const body = { richText: { elems: [{ commonElem: { serviceType: 999, businessType: 0 } }] } };
    expect(isBlankMessage([], body)).toBe(false);
    expect(classifyMessageSurvival(privateHead, [], body)).toBe('keep-undecoded');
  });

  it('keeps a message that decoded to elements', () => {
    expect(classifyMessageSurvival(privateHead, [{ type: 'text' }], {
      richText: { elems: [{ text: { str: 'hi' } }] },
    })).toBe('keep');
  });
});
