import { describe, expect, it } from 'vitest';
import {
  isGroupMessageEvent,
  isMessageEvent,
  isMetaEvent,
  isNoticeEvent,
  isPrivateMessageEvent,
  isRequestEvent,
  noticeType,
  requestType,
  type OneBotGroupMessageEvent,
  type OneBotMetaEvent,
  type OneBotNoticeEvent,
  type OneBotPrivateMessageEvent,
  type OneBotRequestEvent,
  type SnowLumaEvent,
} from '../src';

const PRIVATE_MESSAGE: OneBotPrivateMessageEvent = {
  time: 1_700_000_001,
  self_id: 10000,
  post_type: 'message',
  message_type: 'private',
  sub_type: 'friend',
  message_id: 11,
  message_seq: 12,
  user_id: 20001,
  message: [{ type: 'text', data: { text: 'hi' } }],
  raw_message: 'hi',
  font: 0,
  sender: { user_id: 20001, nickname: 'alice' },
};

const PRIVATE_SENT: OneBotPrivateMessageEvent = {
  time: 1_700_000_002,
  self_id: 10000,
  post_type: 'message_sent',
  message_type: 'private',
  sub_type: 'friend',
  message_id: 13,
  user_id: 20002,
  message: 'echo',
  raw_message: 'echo',
  font: 0,
  sender: { user_id: 10000, nickname: 'bot' },
};

const GROUP_MESSAGE: OneBotGroupMessageEvent = {
  time: 1_700_000_003,
  self_id: 10000,
  post_type: 'message',
  message_type: 'group',
  sub_type: 'normal',
  message_id: 21,
  message_seq: 22,
  group_id: 30001,
  user_id: 20003,
  message: [{ type: 'text', data: { text: 'hey' } }],
  raw_message: 'hey',
  font: 0,
  sender: { user_id: 20003, nickname: 'bob', card: 'Bobby', role: 'member' },
};

const GROUP_SENT: OneBotGroupMessageEvent = {
  time: 1_700_000_004,
  self_id: 10000,
  post_type: 'message_sent',
  message_type: 'group',
  sub_type: 'normal',
  message_id: 23,
  group_id: 30002,
  user_id: 10000,
  message: 'sent',
  raw_message: 'sent',
  font: 0,
  sender: { user_id: 10000, nickname: 'bot' },
};

const NOTICE: OneBotNoticeEvent = {
  time: 1_700_000_005,
  self_id: 10000,
  post_type: 'notice',
  notice_type: 'group_increase',
};

const REQUEST: OneBotRequestEvent = {
  time: 1_700_000_006,
  self_id: 10000,
  post_type: 'request',
  request_type: 'friend',
  flag: 'flag-friend-1',
  user_id: 20004,
  comment: 'please',
};

const META: OneBotMetaEvent = {
  time: 1_700_000_007,
  self_id: 10000,
  post_type: 'meta_event',
  meta_event_type: 'heartbeat',
};

const UNKNOWN: SnowLumaEvent = {
  time: 1_700_000_008,
  self_id: 10000,
  post_type: 'unknown',
};

describe('isMessageEvent', () => {
  it('accepts inbound private and group messages', () => {
    expect(isMessageEvent(PRIVATE_MESSAGE)).toBe(true);
    expect(isMessageEvent(GROUP_MESSAGE)).toBe(true);
  });

  it('accepts message_sent private and group events', () => {
    expect(isMessageEvent(PRIVATE_SENT)).toBe(true);
    expect(isMessageEvent(GROUP_SENT)).toBe(true);
  });

  it('rejects message post types whose message_type is not private or group', () => {
    const guild: SnowLumaEvent = {
      time: 9,
      self_id: 10000,
      post_type: 'message',
      message_type: 'guild',
    };
    const sentChannel: SnowLumaEvent = {
      time: 10,
      self_id: 10000,
      post_type: 'message_sent',
      message_type: 'channel',
    };
    const missingType: SnowLumaEvent = {
      time: 11,
      self_id: 10000,
      post_type: 'message',
    };

    expect(isMessageEvent(guild)).toBe(false);
    expect(isMessageEvent(sentChannel)).toBe(false);
    expect(isMessageEvent(missingType)).toBe(false);
  });

  it('rejects non-message events even when message_type is present', () => {
    const noticeShaped: SnowLumaEvent = {
      time: 12,
      self_id: 10000,
      post_type: 'notice',
      notice_type: 'notify',
      message_type: 'private',
    };

    expect(isMessageEvent(NOTICE)).toBe(false);
    expect(isMessageEvent(REQUEST)).toBe(false);
    expect(isMessageEvent(META)).toBe(false);
    expect(isMessageEvent(UNKNOWN)).toBe(false);
    expect(isMessageEvent(noticeShaped)).toBe(false);
  });
});

describe('isPrivateMessageEvent', () => {
  it('accepts private inbound and sent messages', () => {
    expect(isPrivateMessageEvent(PRIVATE_MESSAGE)).toBe(true);
    expect(isPrivateMessageEvent(PRIVATE_SENT)).toBe(true);
  });

  it('rejects group messages and non-message events', () => {
    expect(isPrivateMessageEvent(GROUP_MESSAGE)).toBe(false);
    expect(isPrivateMessageEvent(GROUP_SENT)).toBe(false);
    expect(isPrivateMessageEvent(NOTICE)).toBe(false);
    expect(isPrivateMessageEvent(REQUEST)).toBe(false);
    expect(isPrivateMessageEvent(META)).toBe(false);
  });

  it('rejects private message_type when post_type is not a message kind', () => {
    const leftover: SnowLumaEvent = {
      time: 13,
      self_id: 10000,
      post_type: 'notice',
      notice_type: 'friend_add',
      message_type: 'private',
    };

    expect(isPrivateMessageEvent(leftover)).toBe(false);
  });
});

describe('isGroupMessageEvent', () => {
  it('accepts group inbound and sent messages', () => {
    expect(isGroupMessageEvent(GROUP_MESSAGE)).toBe(true);
    expect(isGroupMessageEvent(GROUP_SENT)).toBe(true);
  });

  it('rejects private messages and non-message events', () => {
    expect(isGroupMessageEvent(PRIVATE_MESSAGE)).toBe(false);
    expect(isGroupMessageEvent(PRIVATE_SENT)).toBe(false);
    expect(isGroupMessageEvent(NOTICE)).toBe(false);
    expect(isGroupMessageEvent(REQUEST)).toBe(false);
    expect(isGroupMessageEvent(META)).toBe(false);
  });

  it('rejects group message_type when post_type is not a message kind', () => {
    const leftover: SnowLumaEvent = {
      time: 14,
      self_id: 10000,
      post_type: 'request',
      request_type: 'group',
      flag: 'flag-x',
      message_type: 'group',
    };

    expect(isGroupMessageEvent(leftover)).toBe(false);
  });
});

describe('isNoticeEvent', () => {
  it('accepts notice events with a string notice_type', () => {
    expect(isNoticeEvent(NOTICE)).toBe(true);
    expect(isNoticeEvent({
      time: 15,
      self_id: 10000,
      post_type: 'notice',
      notice_type: '',
    })).toBe(true);
  });

  it('rejects notice post_type when notice_type is not a string', () => {
    const missing: SnowLumaEvent = {
      time: 16,
      self_id: 10000,
      post_type: 'notice',
    };
    const numeric: SnowLumaEvent = {
      time: 17,
      self_id: 10000,
      post_type: 'notice',
      notice_type: 7,
    };
    const nulled: SnowLumaEvent = {
      time: 18,
      self_id: 10000,
      post_type: 'notice',
      notice_type: null,
    };

    expect(isNoticeEvent(missing)).toBe(false);
    expect(isNoticeEvent(numeric)).toBe(false);
    expect(isNoticeEvent(nulled)).toBe(false);
  });

  it('rejects other post types', () => {
    expect(isNoticeEvent(PRIVATE_MESSAGE)).toBe(false);
    expect(isNoticeEvent(REQUEST)).toBe(false);
    expect(isNoticeEvent(META)).toBe(false);
    expect(isNoticeEvent(UNKNOWN)).toBe(false);
  });
});

describe('isRequestEvent', () => {
  it('accepts request events with string request_type and flag', () => {
    expect(isRequestEvent(REQUEST)).toBe(true);
    expect(isRequestEvent({
      time: 19,
      self_id: 10000,
      post_type: 'request',
      request_type: 'group',
      sub_type: 'add',
      flag: '',
      group_id: 30003,
    })).toBe(true);
  });

  it('rejects request post_type when request_type or flag is not a string', () => {
    const missingFlag: SnowLumaEvent = {
      time: 20,
      self_id: 10000,
      post_type: 'request',
      request_type: 'friend',
    };
    const numericFlag: SnowLumaEvent = {
      time: 21,
      self_id: 10000,
      post_type: 'request',
      request_type: 'friend',
      flag: 99,
    };
    const missingType: SnowLumaEvent = {
      time: 22,
      self_id: 10000,
      post_type: 'request',
      flag: 'flag-2',
    };
    const numericType: SnowLumaEvent = {
      time: 23,
      self_id: 10000,
      post_type: 'request',
      request_type: 1,
      flag: 'flag-3',
    };
    const nullFlag: SnowLumaEvent = {
      time: 24,
      self_id: 10000,
      post_type: 'request',
      request_type: 'friend',
      flag: null,
    };

    expect(isRequestEvent(missingFlag)).toBe(false);
    expect(isRequestEvent(numericFlag)).toBe(false);
    expect(isRequestEvent(missingType)).toBe(false);
    expect(isRequestEvent(numericType)).toBe(false);
    expect(isRequestEvent(nullFlag)).toBe(false);
  });

  it('rejects other post types even when request fields are present', () => {
    const leftover: SnowLumaEvent = {
      time: 25,
      self_id: 10000,
      post_type: 'notice',
      notice_type: 'group_ban',
      request_type: 'group',
      flag: 'flag-4',
    };

    expect(isRequestEvent(PRIVATE_MESSAGE)).toBe(false);
    expect(isRequestEvent(NOTICE)).toBe(false);
    expect(isRequestEvent(META)).toBe(false);
    expect(isRequestEvent(leftover)).toBe(false);
  });
});

describe('isMetaEvent', () => {
  it('accepts meta_event events with a string meta_event_type', () => {
    expect(isMetaEvent(META)).toBe(true);
    expect(isMetaEvent({
      time: 26,
      self_id: 10000,
      post_type: 'meta_event',
      meta_event_type: 'lifecycle',
    })).toBe(true);
  });

  it('rejects meta_event post_type when meta_event_type is not a string', () => {
    const missing: SnowLumaEvent = {
      time: 27,
      self_id: 10000,
      post_type: 'meta_event',
    };
    const numeric: SnowLumaEvent = {
      time: 28,
      self_id: 10000,
      post_type: 'meta_event',
      meta_event_type: 0,
    };
    const nulled: SnowLumaEvent = {
      time: 29,
      self_id: 10000,
      post_type: 'meta_event',
      meta_event_type: null,
    };

    expect(isMetaEvent(missing)).toBe(false);
    expect(isMetaEvent(numeric)).toBe(false);
    expect(isMetaEvent(nulled)).toBe(false);
  });

  it('rejects other post types', () => {
    expect(isMetaEvent(PRIVATE_MESSAGE)).toBe(false);
    expect(isMetaEvent(NOTICE)).toBe(false);
    expect(isMetaEvent(REQUEST)).toBe(false);
    expect(isMetaEvent(UNKNOWN)).toBe(false);
  });
});

describe('noticeType', () => {
  it('matches notice events by notice_type', () => {
    const isIncrease = noticeType('group_increase');
    const isDecrease = noticeType('group_decrease');

    expect(isIncrease(NOTICE)).toBe(true);
    expect(isDecrease(NOTICE)).toBe(false);
    expect(isIncrease({
      time: 30,
      self_id: 10000,
      post_type: 'notice',
      notice_type: 'group_decrease',
    })).toBe(false);
  });

  it('rejects events that fail isNoticeEvent', () => {
    const isIncrease = noticeType('group_increase');
    const missingType: SnowLumaEvent = {
      time: 31,
      self_id: 10000,
      post_type: 'notice',
    };
    const leftover: SnowLumaEvent = {
      time: 32,
      self_id: 10000,
      post_type: 'message',
      message_type: 'private',
      notice_type: 'group_increase',
    };

    expect(isIncrease(missingType)).toBe(false);
    expect(isIncrease(leftover)).toBe(false);
    expect(isIncrease(REQUEST)).toBe(false);
    expect(isIncrease(PRIVATE_MESSAGE)).toBe(false);
  });
});

describe('requestType', () => {
  it('matches request events by request_type', () => {
    const isFriend = requestType('friend');
    const isGroup = requestType('group');

    expect(isFriend(REQUEST)).toBe(true);
    expect(isGroup(REQUEST)).toBe(false);
    expect(isFriend({
      time: 33,
      self_id: 10000,
      post_type: 'request',
      request_type: 'group',
      flag: 'flag-group-1',
    })).toBe(false);
  });

  it('rejects events that fail isRequestEvent', () => {
    const isFriend = requestType('friend');
    const missingFlag: SnowLumaEvent = {
      time: 34,
      self_id: 10000,
      post_type: 'request',
      request_type: 'friend',
    };
    const leftover: SnowLumaEvent = {
      time: 35,
      self_id: 10000,
      post_type: 'notice',
      notice_type: 'friend_add',
      request_type: 'friend',
      flag: 'flag-5',
    };

    expect(isFriend(missingFlag)).toBe(false);
    expect(isFriend(leftover)).toBe(false);
    expect(isFriend(NOTICE)).toBe(false);
    expect(isFriend(META)).toBe(false);
  });
});
