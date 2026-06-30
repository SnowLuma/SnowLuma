// streaming — Stream API plumbing (#163, NapCat-compatible).
//
// A handful of OneBot actions ("Stream API") answer a single request with
// MANY response frames instead of one: an upload acks each chunk, a download
// pushes the file out chunk-by-chunk. SnowLuma's normal dispatch is strictly
// one-request → one-response, so streaming needs a small seam:
//
//   • a `StreamSink` the action calls to emit intermediate frames, and
//   • per-adapter wiring that writes each frame on the wire (HTTP chunked /
//     repeated WS messages) instead of closing after the first.
//
// Wire format mirrors NapCat exactly so its client scripts work unchanged:
// every frame is an OB11 envelope carrying `stream:'stream-action'`, and the
// frame `data` is a StreamPacket whose `type` is one of stream/response/error.

import type { ApiResponse, JsonValue } from './types';

/** Marks an OB11 envelope as one frame of a streaming response. */
export const STREAM_MARK = 'stream-action';

/** Frame `type` discriminator carried inside each frame's `data`. */
export enum StreamStatus {
  /** An intermediate chunk frame (transfer in progress). */
  Stream = 'stream',
  /** The terminal frame — the stream finished successfully. */
  Response = 'response',
  /** A stream was reset / aborted by the caller. */
  Reset = 'reset',
  /** The terminal frame — the stream failed. */
  Error = 'error',
}

/** A sink an action uses to push intermediate stream frames. Each `send`
 *  carries the raw frame DATA (a StreamPacket: `{ type, data_type, ... }`);
 *  the network adapter wraps it in an OB11 envelope + the stream marker and
 *  flushes it on the wire. The action's eventual return value is the terminal
 *  frame, so do NOT `send` the final result through the sink. */
export interface StreamSink {
  send(frame: JsonValue): Promise<void>;
}

/** Fallback sink for when a stream action is invoked over a transport that
 *  can't stream (or by a plain client): intermediate frames are dropped, the
 *  terminal response is still returned normally. */
export const NOOP_SINK: StreamSink = { send: async () => { /* dropped */ } };

/** Wrap a raw stream-frame `data` payload into an OB11 envelope carrying the
 *  stream marker (mirrors NapCat's `OB11Response.ok(data, echo, true)`). The
 *  empty `message`/`wording` pair matches NapCat — clients reading either key
 *  on an intermediate frame get `''`, never `undefined`. */
export function wrapStreamFrame(data: JsonValue, echo: JsonValue | undefined): ApiResponse {
  const frame: ApiResponse = { status: 'ok', retcode: 0, data, message: '', wording: '', stream: STREAM_MARK };
  if (echo !== undefined) frame.echo = echo;
  return frame;
}

/** Turn an action's terminal `ApiResponse` into the final streaming frame:
 *  attach the stream marker + echo, mirror `wording` into `message` (NapCat
 *  sets both), and — on failure — normalise `data` to an error packet
 *  (`{ type:'error' }`) so NapCat clients see the error `type` while the
 *  human-readable reason stays in `message`/`wording`.
 *
 *  Contract: on success the action's `data` MUST carry `type:'response'` (the
 *  client treats that frame as the stream terminator). Stream actions are
 *  responsible for that, mirroring NapCat's `BaseDownloadStream`. */
export function wrapStreamTerminal(response: ApiResponse, echo: JsonValue | undefined): ApiResponse {
  const frame: ApiResponse = { ...response, stream: STREAM_MARK };
  if (echo !== undefined) frame.echo = echo;
  if (response.status === 'failed') {
    frame.data = { type: StreamStatus.Error, data_type: 'error' };
  }
  frame.message = frame.wording ?? '';
  if (frame.wording === undefined) frame.wording = '';
  return frame;
}
