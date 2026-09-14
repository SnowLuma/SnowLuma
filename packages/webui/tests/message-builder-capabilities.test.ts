import { describe, expect, it } from 'vitest';
import {
  messageBuilderSegmentKinds,
  newSeg,
} from '../src/components/debug/message-builder';
import { messageBuilderModeForAction } from '../src/components/debug/param-field';

describe('action message builder capabilities', () => {
  it('does not offer forward nodes in ordinary message parameters', () => {
    expect(messageBuilderSegmentKinds('message', [])).not.toContain('node');
  });

  it('only offers forward nodes at the root of forward actions', () => {
    expect(messageBuilderSegmentKinds('forward', [])).toEqual(['node']);
  });

  it('locks nested forward content to nodes once a nested node is present', () => {
    expect(messageBuilderSegmentKinds('node-content', [newSeg('node')])).toEqual(['node']);
  });

  it('keeps ordinary nested content free of nodes and window shakes', () => {
    const kinds = messageBuilderSegmentKinds('node-content', [newSeg('text')]);
    expect(kinds).not.toContain('node');
    expect(kinds).not.toContain('poke');
  });

  it('selects the forward-only builder for every forward action', () => {
    expect(messageBuilderModeForAction('send_forward_msg')).toBe('forward');
    expect(messageBuilderModeForAction('send_group_forward_msg')).toBe('forward');
    expect(messageBuilderModeForAction('send_private_forward_msg')).toBe('forward');
    expect(messageBuilderModeForAction('upload_forward_msg')).toBe('forward');
    expect(messageBuilderModeForAction('upload_foward_msg')).toBe('forward');
    expect(messageBuilderModeForAction('send_msg')).toBe('message');
  });
});
