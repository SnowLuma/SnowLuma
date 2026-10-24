import type {
    ActionParams,
    ActionResult,
    DownloadFileStreamComplete,
    JsonObject,
    JsonValue,
    SnowLumaActionMap,
    SnowLumaHttpClient,
    SnowLumaKnownAction,
    SnowLumaWebSocketClient,
    StreamApiResponse,
    UploadFileStreamComplete,
} from '@snowluma/sdk';
import { actionParams, actionResults, type CoveredAction } from './action-contracts.js';

type AssertNever<T extends never> = T;
export type MissingActionTypes = AssertNever<Exclude<SnowLumaKnownAction, keyof SnowLumaActionMap>>;
export type UnregisteredActionTypes = AssertNever<
    Exclude<keyof SnowLumaActionMap, SnowLumaKnownAction>
>;
export type UnspecifiedResults = AssertNever<
    {
        [K in CoveredAction]: JsonValue extends ActionResult<K> ? K : never;
    }[CoveredAction]
>;

type AssertTrue<T extends true> = T;
type Equal<A, B> =
    (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
export type PttAliasParams = AssertTrue<
    Equal<ActionParams<'get_ptt_text'>, ActionParams<'fetch_ptt_text'>>
>;
export type PttAliasResult = AssertTrue<
    Equal<ActionResult<'get_record_text'>, ActionResult<'fetch_ptt_text'>>
>;
export type QuickAlias = AssertTrue<
    Equal<
        SnowLumaActionMap['.handle_quick_operation_async'],
        SnowLumaActionMap['.handle_quick_operation']
    >
>;

declare const http: SnowLumaHttpClient;
declare const ws: SnowLumaWebSocketClient;

export const uploadedFile: Promise<UploadFileStreamComplete> = http.uploadFileStream(
    new Blob(['file']),
);
export const download: AsyncGenerator<Uint8Array, DownloadFileStreamComplete, void> =
    ws.downloadFileStream({ file_id: 'media' }, { action: 'download_file_image_stream' });
export const rawFrames: AsyncIterableIterator<
    StreamApiResponse<ActionResult<'test_download_stream'>>
> = http.requestStream('test_download_stream', {});

for await (const item of ws.stream('download_file_stream', { file: '/remote/file' })) {
    if (item.type === 'stream' && item.data_type === 'file_chunk') {
        const encoded: string = item.data;
        void encoded;
    }
}

// @ts-expect-error single-response actions use request()/call()
http.stream('get_status', {});
// @ts-expect-error uploads accept bytes rather than text chunks
http.uploadFileStream('text');
// @ts-expect-error downloads require a file or file ID
ws.downloadFileStream({});

const feeds = await http.raw('get_qzone_feeds', { page_num: '2', count: 10 });
const more: boolean = feeds.has_more;
const author: number = feeds.feeds[0].uin;
export const legacyFeedHtml: string = feeds.feeds[0].html;
export const feedContent: string | null | undefined = feeds.feeds[0].content;
export const feedPhotos: string[] | null | undefined = feeds.feeds[0].images;
export const feedLikeCount: number | null | undefined = feeds.feeds[0].like_count;
export const feedCursor: string | null | undefined = feeds.next_cursor;
if (feedCursor) {
    await http.raw('get_qzone_feeds', { cursor: feedCursor, count: 10 });
}
export const legacyFeedsResult: ActionResult<'get_qzone_feeds'> = {
    feeds: [{ uin: 10002, nickname: 'User', time: 1, appid: 311, key: 'post', html: '' }],
    has_more: false,
};
// @ts-expect-error continuation tokens must be strings
http.raw('get_qzone_feeds', { cursor: 123 });
const qzoneReply = await http.raw('comment_qzone', actionParams.comment_qzone);
export const qzoneReplyId: string = qzoneReply.comment_id;
export const qzoneParentId: string | undefined = qzoneReply.parent_comment_id;
export const qzoneParentUin: number | undefined = qzoneReply.parent_comment_uin;
export const legacyQzoneComment: ActionParams<'comment_qzone'> = {
    tid: 'post',
    content: 'Comment',
    images: ['https://example.com/image.png'],
};
export const legacyQzoneResult: ActionResult<'comment_qzone'> = { comment_id: '' };
const speech = await ws.raw('get_record_text', { message_id: -42 });
const transcription: string = speech.text;
const flash = await http.raw('get_fileset_info', { fileset_id: 'files' });
const bytes: number = flash.file_list[0].size;
const envelope = await ws.rawResponse('get_fileset_info', actionParams.get_fileset_info);
const filesetId: string = envelope.data.fileset_id;
const album = await http.raw('get_qun_album_list', actionParams.get_qun_album_list);
const count: string = album.album_list[0].upload_number;
const cover: string | null | undefined = album.album_list[0].cover?.image?.defaultUrl?.url;
const upload = await ws.raw('upload_file_stream', { stream_id: 'fixture', verify_only: true });

if (upload.type === 'response') {
    const checksum: string = upload.sha256;
    const received: number = upload.received_chunks;
    void [checksum, received];
} else if (upload.type === 'stream') {
    const status: 'file_created' | 'chunk_received' = upload.status;
    void status;
}

declare const frame: ActionResult<'download_file_stream'>;

if (frame.data_type === 'file_chunk') {
    const chunk: string = frame.data;
    const index: number = frame.index;
    void [chunk, index];
}

// Extra JSON fields and all accepted flash-task forms remain available.
export const extra: ActionParams<'send_qzone_msg'> = { content: 'Post', vendor_option: true };
export const singlePath: ActionParams<'create_flash_task'> = { files: '/fixture' };
export const namedFile: ActionParams<'create_flash_task'> = {
    files: { file: '/fixture', name: 'file' },
};
export const legacyScalars: ActionParams<'modify_custom_face'> = { emoji_id: 123, desc: false };
export const onePermission: ActionParams<'set_group_member_permissions'> = {
    group_id: 10001,
    allow_member_upload_album: false,
};
export const completed: ActionResult<'upload_file_stream'> = {
    type: 'response',
    stream_id: 'fixture',
    status: 'file_complete',
    received_chunks: 1,
    total_chunks: 1,
    file_path: '/fixture',
    file_name: 'file',
    file_size: 1,
    sha256: 'fixture',
};
export const streamError: ActionResult<'download_file_stream'> = {
    type: 'error',
    data_type: 'error',
};

// @ts-expect-error publishing requires content
export const missingContent: ActionParams<'send_qzone_msg'> = {};
// @ts-expect-error flash files must be paths or named file objects
export const invalidFlashFile: ActionParams<'create_flash_task'> = { files: [123] };
// @ts-expect-error a permission patch needs at least one flag
export const missingPermission: ActionParams<'set_group_member_permissions'> = { group_id: 10001 };
export const invalidPolicy: ActionParams<'set_group_member_invite_policy'> = {
    group_id: 10001,
    // @ts-expect-error the policy is a closed server enum
    policy: 'admin_only',
};
// @ts-expect-error uint64 album counters are returned as strings
export const invalidCount: ActionResult<'get_qun_album_list'>['album_list'][number]['upload_number'] = 1;
// @ts-expect-error voice transcription is an object with a text field
export const invalidSpeech: ActionResult<'fetch_ptt_text'> = 'Speech';

// The open action namespace and JSON escape hatch remain available.
declare const dynamicAction: string;
declare const dynamicParams: JsonObject;
const custom: Promise<JsonValue> = http.raw('consumer_extension', { custom: true });
const dynamic: Promise<JsonValue> = ws.raw(dynamicAction, dynamicParams);

export {
    more,
    author,
    transcription,
    bytes,
    filesetId,
    count,
    cover,
    custom,
    dynamic,
    actionResults,
};
export type NewParams = ActionParams<'send_qzone_msg'>;
export type NewResult = ActionResult<'send_qzone_msg'>;
