import { renderParamsVerbose } from '@snowluma/common/log-summary';
import {
  createLogger,
  currentRequestId,
  getLogLevel,
  renderTraceBytes,
  runWithRequestId,
  runWithTraceRequest,
} from '@snowluma/common/logger';

const log = createLogger('WebUI.Mutation');
const READ_ONLY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const STREAMED_REQUEST_PATHS = new Set(['/api/debug/upload']);
const STREAMED_RESPONSE_PATHS = new Set(['/api/debug/invoke-stream']);
// This route can disable TRACE while its own operation is in flight; its
// existing WebUI info record is the authoritative result.
const TRACE_EXCLUDED_PATHS = new Set([
  '/api/auth/check-strength',
  '/api/logs/level',
]);

interface CapturedBody {
  bytes: Uint8Array;
  text: string;
}

function shouldTraceMutation(request: Request): boolean {
  if (getLogLevel() !== 'trace') return false;
  if (READ_ONLY_METHODS.has(request.method.toUpperCase())) return false;
  return !TRACE_EXCLUDED_PATHS.has(new URL(request.url).pathname);
}

async function captureBody(message: Request | Response): Promise<CapturedBody> {
  const bytes = new Uint8Array(await message.arrayBuffer());
  return {
    bytes,
    text: new TextDecoder().decode(bytes),
  };
}

function traceBody(
  branch: 'request_body' | 'response',
  body: CapturedBody,
  response?: Response,
): void {
  log.trace(() => [
    'webui_mutation_branch branch=%s%s length=%d text=%j body=%s',
    branch,
    response
      ? ` status=${response.status} statusText=${JSON.stringify(response.statusText)} headers=${renderParamsVerbose([...response.headers.entries()])}`
      : '',
    body.bytes.byteLength,
    body.text,
    renderTraceBytes(body.bytes),
  ]);
}

function traceStreamChunk(
  branch: 'request_body_chunk' | 'response_chunk',
  chunk: Uint8Array,
  offset: number,
): void {
  log.trace(() => [
    'webui_mutation_branch branch=%s offset=%d length=%d body=%s',
    branch,
    offset,
    chunk.byteLength,
    renderTraceBytes(chunk),
  ]);
}

export function traceWebuiMutationRequestChunk(chunk: Uint8Array, offset: number): void {
  traceStreamChunk('request_body_chunk', chunk, offset);
}

function traceStreamedResponse(
  response: Response,
  requestBody: Promise<CapturedBody> | null,
  startedAt: number,
): Response {
  if (!response.body) {
    void settleMutation(
      requestBody,
      Promise.resolve({ bytes: new Uint8Array(), text: '' }),
      response,
      startedAt,
      false,
    );
    return response;
  }

  const reader = response.body.getReader();
  const requestId = currentRequestId();
  const inContext = <T>(fn: () => T): T => requestId === undefined
    ? fn()
    : runWithRequestId(requestId, fn);
  let offset = 0;
  let settled = false;
  const terminal = (outcome: 'completed' | 'failed' | 'cancelled', reason: string, error?: unknown) => {
    if (settled) return;
    settled = true;
    void inContext(() => traceRequestBody(requestBody)).then(() => {
      inContext(() => log.trace(
        'webui_mutation_terminal outcome=%s reason=%s status=%d%s elapsedMs=%d',
        outcome,
        reason,
        response.status,
        error === undefined ? '' : ` error=${JSON.stringify(error instanceof Error ? error.message : String(error))}`,
        Date.now() - startedAt,
      ));
    });
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          terminal(response.ok ? 'completed' : 'failed', response.ok ? 'response_completed' : 'http_status');
          controller.close();
          return;
        }
        const chunk = result.value;
        inContext(() => traceStreamChunk('response_chunk', chunk, offset));
        offset += chunk.byteLength;
        controller.enqueue(chunk);
      } catch (error) {
        terminal(error instanceof Error && error.name === 'AbortError' ? 'cancelled' : 'failed',
          error instanceof Error && error.name === 'AbortError' ? 'body_cancelled' : 'body_read_failed', error);
        controller.error(error);
      }
    },
    async cancel(reason) {
      terminal('cancelled', 'body_cancelled', reason);
      await reader.cancel(reason);
    },
  }, { highWaterMark: 0 });
  return new Response(body, response);
}

async function traceRequestBody(requestBody: Promise<CapturedBody> | null): Promise<void> {
  if (!requestBody) return;
  try {
    traceBody('request_body', await requestBody);
  } catch (error) {
    log.trace(
      'webui_mutation_branch branch=request_body_failed error=%j',
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function settleMutation(
  requestBody: Promise<CapturedBody> | null,
  responseBody: Promise<CapturedBody>,
  response: Response,
  startedAt: number,
  requestCancelled: boolean,
): Promise<void> {
  const results = await Promise.allSettled([
    requestBody ?? Promise.resolve<CapturedBody>({ bytes: new Uint8Array(), text: '' }),
    responseBody,
  ]);
  const [requestResult, responseResult] = results;
  if (requestBody && requestResult.status === 'fulfilled') traceBody('request_body', requestResult.value);
  if (requestBody && requestResult.status === 'rejected') {
    log.trace('webui_mutation_branch branch=request_body_failed error=%j',
      requestResult.reason instanceof Error ? requestResult.reason.message : String(requestResult.reason));
  }
  if (responseResult.status === 'fulfilled') traceBody('response', responseResult.value, response);
  else {
    log.trace(() => [
      'webui_mutation_branch branch=response_body_failed status=%d statusText=%j headers=%s error=%j',
      response.status,
      response.statusText,
      renderParamsVerbose([...response.headers.entries()]),
      responseResult.reason instanceof Error ? responseResult.reason.message : String(responseResult.reason),
    ]);
  }
  const error = responseResult.status === 'rejected'
    ? responseResult.reason
    : requestResult.status === 'rejected'
      ? requestResult.reason
      : undefined;
  if (error === undefined) {
    if (requestCancelled) {
      log.trace(
        'webui_mutation_terminal outcome=cancelled reason=request_cancelled status=%d elapsedMs=%d',
        response.status,
        Date.now() - startedAt,
      );
      return;
    }
    log.trace(
      'webui_mutation_terminal outcome=%s reason=%s status=%d elapsedMs=%d',
      response.ok ? 'completed' : 'failed',
      response.ok ? 'response_completed' : 'http_status',
      response.status,
      Date.now() - startedAt,
    );
    return;
  }
  log.trace(
    'webui_mutation_terminal outcome=%s reason=%s error=%j elapsedMs=%d',
    error instanceof Error && error.name === 'AbortError' ? 'cancelled' : 'failed',
    error instanceof Error && error.name === 'AbortError' ? 'body_cancelled' : 'body_read_failed',
    error instanceof Error ? error.message : String(error),
    Date.now() - startedAt,
  );
}

function failureOutcome(error: unknown): {
  outcome: 'failed' | 'timeout' | 'cancelled';
  reason: string;
} {
  if (error instanceof Error && error.name === 'TimeoutError') {
    return { outcome: 'timeout', reason: 'handler_timeout' };
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return { outcome: 'cancelled', reason: 'handler_cancelled' };
  }
  return { outcome: 'failed', reason: 'handler_threw' };
}

/** Trace one authenticated WebUI write without consuming its live streams. */
export function traceAuthenticatedWebuiMutation(
  request: Request,
  next: () => Promise<Response>,
): Promise<Response> {
  if (!shouldTraceMutation(request)) return next();

  return runWithTraceRequest(async () => {
    const startedAt = Date.now();
    const requestHeaders = [...request.headers.entries()];
    const pathname = new URL(request.url).pathname;
    let requestBody: Promise<CapturedBody> | null = null;

    log.trace(() => [
      'webui_mutation_start method=%j url=%j headers=%s',
      request.method,
      request.url,
      renderParamsVerbose(requestHeaders),
    ]);

    if (!STREAMED_REQUEST_PATHS.has(pathname)) {
      try {
        requestBody = captureBody(request.clone());
      } catch (error) {
        log.trace(
          'webui_mutation_terminal outcome=failed reason=request_clone_failed error=%j elapsedMs=%d',
          error instanceof Error ? error.message : String(error),
          Date.now() - startedAt,
        );
        return next();
      }
    }

    try {
      const response = await next();
      if (STREAMED_RESPONSE_PATHS.has(pathname)) {
        return traceStreamedResponse(response, requestBody, startedAt);
      }
      let responseBody: Promise<CapturedBody>;
      try {
        responseBody = captureBody(response.clone());
      } catch (error) {
        void traceRequestBody(requestBody).then(() => {
          log.trace(
            'webui_mutation_terminal outcome=failed reason=response_clone_failed error=%j elapsedMs=%d',
            error instanceof Error ? error.message : String(error),
            Date.now() - startedAt,
          );
        });
        return response;
      }

      void settleMutation(
        requestBody,
        responseBody,
        response,
        startedAt,
        STREAMED_REQUEST_PATHS.has(pathname) && request.signal.aborted,
      );
      return response;
    } catch (error) {
      await traceRequestBody(requestBody);
      const failure = failureOutcome(error);
      log.trace(
        'webui_mutation_terminal outcome=%s reason=%s error=%j elapsedMs=%d',
        failure.outcome,
        failure.reason,
        error instanceof Error ? error.message : String(error),
        Date.now() - startedAt,
      );
      throw error;
    }
  });
}
