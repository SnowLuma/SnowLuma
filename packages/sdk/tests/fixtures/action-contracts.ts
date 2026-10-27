import type { ActionParams, ActionResult } from '@snowluma/sdk';

const album = { group_id: '10001', album_id: 'album' };
const mediaLike = { ...album, batch_id: '9007199254740993', lloc: 'photo' };
const mediaUpload = { ...album, album_name: 'Album', file: 'file:///fixture' };
const download = { file: 'https://example.com/file', file_id: 'cached', chunk_size: '65536' };
const fileset = { fileset_id: 'fileset' };
const flashFile = { ...fileset, file_name: 'file.txt', file_index: '0' };
const peer = { group_id: '10001', user_id: '10002', phone_number: '' };
const qzoneLike = { tid: 'post', target_uin: '10002', abstime: '1700000000' };
const qzonePublicFeed = {
    cell_common: {
        domain_type: 3,
        union_id: { uf_key: '9007199254740993', unknown_identity: 'preserved' },
    },
    cell_feed_transfer: { opaque: 'fixture' },
    unknown_cell: { decimal: '18446744073709551615' },
};
const qzonePublicComment = {
    id: '9007199254740993',
    user: { uid: 'public-reader' },
    like: { id: 'comment-like-key' },
};
const qzonePublicReply = {
    id: '18446744073709551615',
    user: { uid: 'public-author' },
    like: { id: 'reply-like-key' },
};

// The same examples are compiled against the published declarations and parsed
// by the real server action definitions. They never invoke QQ or perform I/O.
export const actionParams = {
    get_group_admin_permissions: { group_id: '10001', user_id: '10002' },
    set_group_admin_permissions: {
        group_id: '10001',
        user_id: '10002',
        recall_member_message: false,
        kick_member: true,
        kick_member_per_day: '20',
    },
    set_group_admin_receive_verify: { group_id: '10001', user_id: '10002', enable: 'on' },
    _get_friend_dress: { user_id: '10002' },
    add_custom_face: { file: 'file:///fixture.png' },
    cancel_group_album_media_like: mediaLike,
    clean_stream_temp_file: {},
    comment_qzone: {
        tid: 'post',
        content: 'Comment',
        target_uin: '10002',
        images: [],
        comment_id: '0',
        comment_uin: '10003',
        reply_uin: '10004',
        reply_name: 'Reader',
    },
    comment_qzone_public_feed: {
        feed: qzonePublicFeed,
        content: [{ type: 0, content: 'Comment', upstream_option: true }],
    },
    create_flash_task: {
        files: ['file:///one', { file: 'file:///two', name: 'two.txt' }],
        name: 'Files',
        thumb_path: '',
    },
    del_group_album_media: { ...album, lloc: 'photo' },
    delete_custom_face: { emoji_id: 'face' },
    delete_flash_file: fileset,
    delete_qzone_msg: { tid: 'post' },
    delete_qzone_public_comment: { feed: qzonePublicFeed, comment: qzonePublicComment },
    delete_qzone_public_reply: {
        feed: qzonePublicFeed,
        comment: qzonePublicComment,
        reply: qzonePublicReply,
    },
    do_group_album_comment: { ...album, lloc: 'photo', content: 'Comment' },
    download_file_image_stream: download,
    download_file_record_stream: download,
    download_file_stream: download,
    download_fileset: flashFile,
    fetch_custom_face_detail: { count: '48' },
    fetch_ptt_text: { message_id: -42 },
    forward_qzone_public_feed: { feed: qzonePublicFeed, reason: '' },
    get_ptt_text: { message_id: '-42' },
    get_record_text: { message_id: -42 },
    get_doubt_friends_add_request: { count: '50' },
    get_fileset_id: { share_code: 'share' },
    get_fileset_info: fileset,
    get_flash_file_list: fileset,
    get_flash_file_url: flashFile,
    get_group_album_list: { group_id: '10001' },
    get_group_album_media_list: { ...album, attach_info: '' },
    get_group_signed_list: { group_id: '10001' },
    get_msg_emoji_likes: { message_id: '-42' },
    get_qun_album_list: { group_id: '10001', attach_info: '' },
    get_qzone_feeds: { page_num: '1', count: '10', cursor: 'cursor-from-previous-response' },
    get_qzone_msg_list: { target_uin: '10002', pos: '0', num: '20' },
    get_qzone_profile: { target_uin: '10002' },
    get_qzone_public_capabilities: {},
    get_qzone_public_comments: { feed: qzonePublicFeed, cursor: 'comments-from-detail' },
    get_qzone_public_feed_detail: { feed: qzonePublicFeed },
    get_qzone_public_feeds: { cursor: 'public-feed-cursor' },
    get_qzone_public_replies: {
        feed: qzonePublicFeed,
        comment: qzonePublicComment,
        cursor: '',
        page_size: '20',
    },
    get_rkey_server: {},
    get_share_link: fileset,
    like_qzone: qzoneLike,
    list_filesets: {},
    modify_custom_face: { emoji_id: 'face', desc: 'Description' },
    move_custom_face_to_front: { emoji_id: 'face' },
    rename_flash_file: { ...fileset, new_name: 'new.txt' },
    reply_qzone_public_feed: {
        feed: qzonePublicFeed,
        comment: qzonePublicComment,
        content: 'Reply',
        reply: qzonePublicReply,
    },
    request_decrypt_key: { db_path: '/fixture.db' },
    send_ark_share: peer,
    send_flash_msg: { ...fileset, group_id: '10001', user_id: '10002' },
    send_group_ark_share: { group_id: '10001' },
    send_qzone_msg: {
        content: 'Post',
        images: [],
        ugc_right: '16',
        target_uins: ['10002'],
    },
    send_tuwen_ark: {
        group_id: '10001',
        user_id: '10002',
        title: 'Title',
        desc: 'Description',
        summary: 'Summary',
        preview_url: '',
        jump_url: 'https://example.com/',
    },
    set_doubt_friends_add_request: { flag: 'u_fixture', approve: 'yes' },
    set_group_album_media_like: mediaLike,
    set_group_member_invite_policy: { group_id: '10001', policy: 'require_approval' },
    set_group_member_permissions: {
        group_id: '10001',
        allow_member_upload_album: false,
        allow_member_temporary_session: 'off',
        allow_member_create_group: 1,
    },
    set_group_new_member_history_visibility: { group_id: '10001', visible: 'on' },
    set_group_robot_add_option: {
        group_id: '10001',
        robot_member_switch: '1',
        robot_member_examine: '0',
    },
    set_qzone_ban: { user_id: '10002', enable: false },
    set_qzone_msg_right: { tid: 'post', ugc_right: '128', target_uins: ['10002'] },
    set_qzone_profile: { name: 'Space', description: '' },
    set_qzone_public_follow: { feed: qzonePublicFeed, enable: 'off' },
    set_qzone_public_comment_like: {
        feed: qzonePublicFeed,
        comment: qzonePublicComment,
        reply: qzonePublicReply,
        enable: 'on',
    },
    set_qzone_public_like: { feed: qzonePublicFeed, enable: 0 },
    set_qzone_public_upvote: { feed: qzonePublicFeed, enable: true },
    share_group_ex: { group_id: '10001' },
    share_peer: peer,
    test_download_stream: { error: false },
    unlike_qzone: qzoneLike,
    upload_file_stream: {
        stream_id: 'fixture',
        chunk_data: 'YQ==',
        chunk_index: '0',
        total_chunks: '1',
        file_size: '1',
        expected_sha256: '',
        is_complete: 'false',
        filename: 'file.txt',
        reset: false,
        verify_only: 0,
        file_retention: '0',
    },
    upload_image_to_qun_album: mediaUpload,
    upload_video_to_qun_album: mediaUpload,
    '.handle_quick_operation_async': { context: {}, operation: {} },
} satisfies { [K in CoveredAction]: ActionParams<K> };

// Keep this independent of SnowLumaActionMap: a missing map entry must fail the
// consumer's coverage check rather than silently remove that example.
export type CoveredAction =
    | 'get_group_admin_permissions'
    | 'set_group_admin_permissions'
    | 'set_group_admin_receive_verify'
    | '_get_friend_dress'
    | 'add_custom_face'
    | 'cancel_group_album_media_like'
    | 'clean_stream_temp_file'
    | 'comment_qzone'
    | 'comment_qzone_public_feed'
    | 'create_flash_task'
    | 'del_group_album_media'
    | 'delete_custom_face'
    | 'delete_flash_file'
    | 'delete_qzone_msg'
    | 'delete_qzone_public_comment'
    | 'delete_qzone_public_reply'
    | 'do_group_album_comment'
    | 'download_file_image_stream'
    | 'download_file_record_stream'
    | 'download_file_stream'
    | 'download_fileset'
    | 'fetch_custom_face_detail'
    | 'fetch_ptt_text'
    | 'forward_qzone_public_feed'
    | 'get_ptt_text'
    | 'get_record_text'
    | 'get_doubt_friends_add_request'
    | 'get_fileset_id'
    | 'get_fileset_info'
    | 'get_flash_file_list'
    | 'get_flash_file_url'
    | 'get_group_album_list'
    | 'get_group_album_media_list'
    | 'get_group_signed_list'
    | 'get_msg_emoji_likes'
    | 'get_qun_album_list'
    | 'get_qzone_feeds'
    | 'get_qzone_msg_list'
    | 'get_qzone_profile'
    | 'get_qzone_public_capabilities'
    | 'get_qzone_public_comments'
    | 'get_qzone_public_feed_detail'
    | 'get_qzone_public_feeds'
    | 'get_qzone_public_replies'
    | 'get_rkey_server'
    | 'get_share_link'
    | 'like_qzone'
    | 'list_filesets'
    | 'modify_custom_face'
    | 'move_custom_face_to_front'
    | 'rename_flash_file'
    | 'reply_qzone_public_feed'
    | 'request_decrypt_key'
    | 'send_ark_share'
    | 'send_flash_msg'
    | 'send_group_ark_share'
    | 'send_qzone_msg'
    | 'send_tuwen_ark'
    | 'set_doubt_friends_add_request'
    | 'set_group_album_media_like'
    | 'set_group_member_invite_policy'
    | 'set_group_member_permissions'
    | 'set_group_new_member_history_visibility'
    | 'set_group_robot_add_option'
    | 'set_qzone_ban'
    | 'set_qzone_msg_right'
    | 'set_qzone_profile'
    | 'set_qzone_public_follow'
    | 'set_qzone_public_comment_like'
    | 'set_qzone_public_like'
    | 'set_qzone_public_upvote'
    | 'share_group_ex'
    | 'share_peer'
    | 'test_download_stream'
    | 'unlike_qzone'
    | 'upload_file_stream'
    | 'upload_image_to_qun_album'
    | 'upload_video_to_qun_album'
    | '.handle_quick_operation_async';

const flashInfo = {
    fileset_id: 'fileset',
    file_name: 'file.txt',
    orig_name: 'original.txt',
    size: 42,
    share_url: 'https://example.com/share',
    file_id: 'file',
    download_url: '',
};

export const actionResults = {
    get_group_admin_permissions: {
        group_id: 10001,
        user_id: 10002,
        recall_member_message: null,
        kick_member: true,
        kick_member_per_day: 20,
        receive_verify: false,
    },
    set_group_admin_permissions: null,
    set_group_admin_receive_verify: null,
    _get_friend_dress: {
        target_uin: '10002',
        is_svip: true,
        avatar_url: '',
        items: [
            {
                app_id: 15,
                kind: 'card',
                item_id: 1,
                name: 'Card',
                preview_url: '',
                video_url: '',
                price: 0,
            },
        ],
    },
    add_custom_face: { emoji_id: 'face' },
    cancel_group_album_media_like: {},
    clean_stream_temp_file: { message: 'success', removed: 1, freed_bytes: 42, skipped_active: 1 },
    comment_qzone: { comment_id: 'comment' },
    comment_qzone_public_feed: { comment: qzonePublicComment },
    create_flash_task: { fileset_id: 'fileset', task_id: 'fileset' },
    del_group_album_media: { success: true },
    delete_custom_face: null,
    delete_flash_file: null,
    delete_qzone_msg: null,
    delete_qzone_public_comment: {},
    delete_qzone_public_reply: {},
    do_group_album_comment: {
        id: 'comment',
        user: { uin: '10002' },
        content: [{ type: 0, content: 'Comment' }],
        time: '1700000000',
        clientKey: 'fixture',
    },
    download_file_image_stream: {
        type: 'stream',
        data_type: 'file_info',
        file_name: 'image',
        file_size: 1,
        chunk_size: 1,
    },
    download_file_record_stream: {
        type: 'stream',
        data_type: 'file_chunk',
        index: 0,
        data: 'YQ==',
        size: 1,
        progress: 100,
        base64_size: 4,
    },
    download_file_stream: {
        type: 'response',
        data_type: 'file_complete',
        file_name: 'file',
        total_chunks: 1,
        total_bytes: 1,
        message: 'Download completed',
    },
    download_fileset: { url: '', file_name: 'file.txt', file_size: 42 },
    fetch_custom_face_detail: [{ emoji_id: 'face', resId: 'face', url: '', md5: '', desc: '' }],
    fetch_ptt_text: { text: 'Speech' },
    forward_qzone_public_feed: {},
    get_ptt_text: { text: 'Speech' },
    get_record_text: { text: 'Speech' },
    get_doubt_friends_add_request: [
        {
            uid: 'u_fixture',
            user_id: 10002,
            nick: 'User',
            source: '',
            reason: '',
            msg: '',
            group_code: '',
            reqTime: 0,
        },
    ],
    get_fileset_id: { fileset_id: 'fileset' },
    get_fileset_info: { fileset_id: 'fileset', file_list: [flashInfo] },
    get_flash_file_list: [flashInfo],
    get_flash_file_url: { url: '' },
    get_group_album_list: [
        {
            id: 'album',
            name: 'Album',
            picNum: 1,
            createTime: 1,
            desc: '',
            owner: '10002',
            createuin: '10002',
            createnickname: 'User',
            last_upload_time: 1,
            cover: null,
        },
    ],
    get_group_album_media_list: {
        mediaList: [
            {
                type: 2,
                video: { id: 'video', videoTime: '1000' },
                batchId: '9007199254740993',
                uploadTime: '1',
            },
        ],
        nextAttachInfo: '',
    },
    get_group_signed_list: [{ user_id: 10002, nick: 'User', time: 1, rank: 1 }],
    get_msg_emoji_likes: [
        {
            emoji_id: '1',
            emoji_type: 1,
            count: 1,
            last_reaction_time: 1,
            users: [{ user_id: 10002 }],
        },
    ],
    get_qun_album_list: {
        album_list: [
            {
                album_id: 'album',
                owner: '10002',
                name: 'Album',
                desc: '',
                create_time: '1',
                modify_time: '1',
                last_upload_time: '1',
                upload_number: '9007199254740993',
                cover: {
                    type: 1,
                    image: {
                        name: '',
                        sloc: '',
                        lloc: '',
                        photoUrls: [],
                        defaultUrl: null,
                        isGif: false,
                        hasRaw: false,
                    },
                },
                top_flag: '0',
                busi_type: 0,
                status: 0,
                allow_share: true,
                is_subscribe: false,
                bitmap: '',
                is_share_album: false,
                qz_album_type: 0,
                cover_type: 0,
                default_desc: '',
                sort_type: 0,
            },
        ],
        attach_info: '',
        has_more: false,
    },
    get_qzone_feeds: {
        feeds: [{ uin: 10002, nickname: 'User', time: 1, appid: 311, key: 'post', html: '' }],
        has_more: false,
    },
    get_qzone_msg_list: {
        total: 1,
        msglist: [
            {
                tid: 'post',
                content: 'Post',
                time: 1,
                comment_num: 0,
                is_private: false,
                images: [],
            },
        ],
    },
    get_qzone_profile: { name: 'Space', description: 'Description' },
    get_qzone_public_capabilities: { public_qzone_entrance_switch: true, can_upvote: true },
    get_qzone_public_comments: {
        cell_comment: { comments: [qzonePublicComment] },
        attach_info: 'next-comments',
        has_more: true,
    },
    get_qzone_public_feed_detail: {
        feed: { feed: qzonePublicFeed },
        attach_info: 'comments-from-detail',
        has_more: true,
    },
    get_qzone_public_feeds: {
        feeds: [qzonePublicFeed],
        has_more: true,
        next_cursor: 'public-feed-cursor',
        unknown_page: { preserved: true },
    },
    get_qzone_public_replies: {
        replys: [qzonePublicReply],
        reply_attach_info: '',
        has_more: false,
    },
    get_rkey_server: { expired_time: 1, name: 'SnowLuma', private_rkey: 'fixture' },
    get_share_link: 'https://example.com/share',
    like_qzone: null,
    list_filesets: [flashInfo],
    modify_custom_face: null,
    move_custom_face_to_front: null,
    rename_flash_file: null,
    reply_qzone_public_feed: { reply: qzonePublicReply },
    request_decrypt_key: { db_key: 'fixture' },
    send_ark_share: { arkMsg: '{}' },
    send_flash_msg: { message_id: 0 },
    send_group_ark_share: '{}',
    send_qzone_msg: { tid: 'post', time: 1 },
    send_tuwen_ark: null,
    set_doubt_friends_add_request: null,
    set_group_album_media_like: { id: 'like', status: 1 },
    set_group_member_invite_policy: null,
    set_group_member_permissions: null,
    set_group_new_member_history_visibility: null,
    set_group_robot_add_option: null,
    set_qzone_ban: null,
    set_qzone_msg_right: { ugc_right: 128 },
    set_qzone_profile: null,
    set_qzone_public_follow: { ret_code: 0 },
    set_qzone_public_comment_like: { like: { status: 1 } },
    set_qzone_public_like: { like: { liked: true } },
    set_qzone_public_upvote: { upvote: { upvoted: true } },
    share_group_ex: '{}',
    share_peer: { arkMsg: '{}' },
    test_download_stream: {
        type: 'response',
        data_type: 'data_complete',
        data: 'Stream transmission complete',
    },
    unlike_qzone: null,
    upload_file_stream: {
        type: 'stream',
        stream_id: 'fixture',
        status: 'chunk_received',
        received_chunks: 1,
        total_chunks: 1,
    },
    upload_image_to_qun_album: null,
    upload_video_to_qun_album: { id: 'video' },
    '.handle_quick_operation_async': null,
} satisfies { [K in CoveredAction]: ActionResult<K> };
