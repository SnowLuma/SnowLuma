import { describe, expect, it } from 'vitest';
import { protobuf_encode } from '@snowluma/proton';
import { decodeRichBody } from '../../src/msg-push/rich-body-decoder';
import type { MessageBody } from '@snowluma/proto-defs/message';
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
