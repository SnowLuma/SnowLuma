import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import { decodeRichBody } from '../../src/msg-push/rich-body-decoder';
import type { MessageBody, PushMsg } from '@snowluma/proto-defs/message';
import type { MarkdownData } from '@snowluma/proto-defs/action';

// Build a svc=45 richui markdown commonElem carrying a FlashTransfer card, the
// way older QQ clients (≤9.9.30) deliver a 闪传 file (#199/#200).
function flashBody(json: unknown): MessageBody {
  const markdown = `[闪传](mqqapi://markdown/node?nodeType=richui&json=${encodeURIComponent(JSON.stringify(json))})`;
  const pbElem = protobuf_encode<MarkdownData>({ content: markdown });
  return {
    richText: { elems: [{ commonElem: { serviceType: 45, businessType: 3, pbElem } } as never] },
  };
}

describe('decodeRichBody / 闪传 flash_file (#199/#200)', () => {
  it('extracts filesetId, title, sceneType from a nested FlashTransfer card', () => {
    const out = decodeRichBody(flashBody({
      busId: 'FlashTransfer',
      templateId: 'flash',
      version: 2,
      layout: { viewId: 'flash_file', width: -2, height: -2 },
      data: { fileSetId: 'fs-abc-123', title: 'report.pdf', sceneType: 2 },
    }), true);
    expect(out).toEqual([{ type: 'flash_file', filesetId: 'fs-abc-123', fileName: 'report.pdf', sceneType: 2 }]);
  });

  it('recursive search finds the fields at any depth + accepts the filesetId alias', () => {
    const out = decodeRichBody(flashBody({
      busId: 'FlashTransfer',
      templateId: 'flash',
      layout: { deep: { nested: { filesetId: 'fs-deep', name: 'a.zip' } } },
    }), true);
    expect(out).toEqual([{ type: 'flash_file', filesetId: 'fs-deep', fileName: 'a.zip', sceneType: 0 }]);
  });

  it('drops a malformed card that has no fileset identity', () => {
    const out = decodeRichBody(flashBody({ busId: 'FlashTransfer', templateId: 'flash' }), true);
    expect(out).toEqual([]);
  });

  it('does not misclassify a non-FlashTransfer markdown card as flash_file', () => {
    const out = decodeRichBody(flashBody({ busId: 'SomethingElse', templateId: 'button' }), true);
    expect(out.some((e) => e.type === 'flash_file')).toBe(false);
    expect(out[0]?.type).toBe('markdown');
  });
});

// Current NT cards (#358) put fileset identity on MarkdownData.extInfo
// (extType=1 / DecodeMdExtInfoFileTransfer) and in the click scheme. The
// richui JSON no longer has `data.fileSetId`.
function currentNtFlashBody(json: unknown, ext?: MarkdownData['extInfo'], summary?: string): MessageBody {
  const markdown = `[闪传](mqqapi://markdown/node?nodeType=richui&json=${encodeURIComponent(JSON.stringify(json))})`;
  const pbElem = protobuf_encode<MarkdownData>({
    content: markdown,
    summary,
    extType: ext ? 1 : undefined,
    extInfo: ext,
  });
  return {
    richText: { elems: [{ commonElem: { serviceType: 45, businessType: 3, pbElem } } as never] },
  };
}

const currentNtCardJson = {
  busId: 'FlashTransfer',
  templateId: 'flash',
  version: 2,
  layout: { viewId: 'flash_file', width: -2, height: -2, direction: 'horizontal' },
  attributes: {
    viewId: 'flash_file',
    attributes: [{
      viewId: 'file',
      scheme: 'mqqrouter://flash_transfer/open_fileset?fileset_id=fs-nt-358&version=1&channel_id=1&src_type=internal&scene_type=1',
    }],
  },
};

describe('decodeRichBody / 闪传 flash_file (#358 current NT card)', () => {
  it('reads filesetId and name from markdown extInfo when the JSON has no data.fileSetId', () => {
    const out = decodeRichBody(currentNtFlashBody(currentNtCardJson, {
      filesetId: 'fs-nt-358',
      name: 'cpwd截图.zip',
      fileSize: 9196055,
      expireTime: 1787815533,
    }, '[QQ闪传] cpwd截图.zip'), true);
    expect(out).toEqual([{
      type: 'flash_file',
      filesetId: 'fs-nt-358',
      fileName: 'cpwd截图.zip',
      sceneType: 1,
    }]);
  });

  it('falls back to the open_fileset scheme when extInfo is absent', () => {
    const out = decodeRichBody(currentNtFlashBody(currentNtCardJson), true);
    expect(out).toEqual([{
      type: 'flash_file',
      filesetId: 'fs-nt-358',
      fileName: '',
      sceneType: 1,
    }]);
  });

  it('still decodes from extInfo when the richui JSON is truncated', () => {
    const markdown = '[闪传](mqqapi://markdown/node?nodeType=richui&json=%7B%22busId%22%3A%22FlashTransfer%22%2C%22src%22%3A%22';
    const pbElem = protobuf_encode<MarkdownData>({
      content: markdown,
      summary: '[QQ闪传] report.pdf',
      extType: 1,
      extInfo: { filesetId: 'fs-from-ext', name: 'report.pdf' },
    });
    const out = decodeRichBody({
      richText: { elems: [{ commonElem: { serviceType: 45, businessType: 3, pbElem } } as never] },
    }, true);
    expect(out).toEqual([{
      type: 'flash_file',
      filesetId: 'fs-from-ext',
      fileName: 'report.pdf',
      sceneType: 0,
    }]);
  });

  it('drops the compatibility text sibling after a successful flash_file decode', () => {
    const markdown = `[闪传](mqqapi://markdown/node?nodeType=richui&json=${encodeURIComponent(JSON.stringify(currentNtCardJson))})`;
    const pbElem = protobuf_encode<MarkdownData>({
      content: markdown,
      extType: 1,
      extInfo: { filesetId: 'fs-nt-358', name: 'a.zip' },
    });
    const out = decodeRichBody({
      richText: {
        elems: [
          { commonElem: { serviceType: 45, businessType: 3, pbElem } } as never,
          { text: { str: '[闪传]' } } as never,
        ],
      },
    }, true);
    expect(out).toEqual([{
      type: 'flash_file',
      filesetId: 'fs-nt-358',
      fileName: 'a.zip',
      sceneType: 1,
    }]);
  });

  it('decodes the sanitized #358 C2C push (extInfo + open_fileset scheme)', () => {
    const hex = readFileSync(
      fileURLToPath(new URL('./fixtures/issue-358-flash-push.hex', import.meta.url)),
      'utf8',
    ).trim();
    const push = protobuf_decode<PushMsg>(Buffer.from(hex, 'hex'));
    const out = decodeRichBody(push.message?.body, false);
    // Reporter redacted the richui JSON (unterminated src), so scene_type
    // cannot be recovered from the scheme. extInfo still supplies fileset + name.
    expect(out).toEqual([{
      type: 'flash_file',
      filesetId: '[UUID]',
      fileName: 'cpwd截图.zip',
      sceneType: 0,
    }]);
  });
});
