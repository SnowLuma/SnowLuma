import http from 'node:http';
import https from 'node:https';
import {
  createLogger,
  getLogLevel,
  renderTraceBytes,
  runWithTraceRequest,
} from '@snowluma/common/logger';
import { renderParamsVerbose } from '@snowluma/common/log-summary';

const log = createLogger('Protocol.Http');

type RequestBody = string | Buffer | Uint8Array | Record<string, unknown> | undefined;

export interface HttpResponseLimits {
  /** Wall-clock deadline shared by the complete redirect chain. */
  timeoutMs?: number;
  /** Maximum response body size measured in bytes before decoding. */
  maxResponseBytes?: number;
}

function validateLimit(name: keyof HttpResponseLimits, value: number | undefined): void {
  const exceedsTimerRange = name === 'timeoutMs' && value !== undefined && value > 2_147_483_647;
  if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0 || exceedsTimerRange)) {
    throw new Error(`${name} must be a positive safe integer`);
  }
}

interface HttpRequestContext {
  url: string;
  method: string;
  data?: RequestBody;
  headers: Record<string, string>;
  isJsonRet: boolean;
  isArgJson: boolean;
  maxRedirects: number;
  responseLimits: HttpResponseLimits;
  deadlineAt?: number;
}

type HttpTerminalReason =
  | 'deadline'
  | 'non_2xx'
  | 'parse_failure'
  | 'redirect_failure'
  | 'request_invalid'
  | 'response_aborted'
  | 'response_too_large'
  | 'transport_failure';

type HttpOperationOutcome = 'failed' | 'timeout' | 'cancelled';

interface HttpFailureClassification {
  outcome: HttpOperationOutcome;
  reason: HttpTerminalReason;
}

const httpFailures = new WeakMap<Error, HttpFailureClassification>();

type CookieTerminalReason =
  | 'response_complete'
  | 'redirect_limit'
  | 'redirect_failure'
  | 'deadline'
  | 'transport_failure';

interface CookieCollectionResult {
  reason: CookieTerminalReason;
  error?: Error;
}

interface HttpTraceOperation {
  readonly startedAt: number;
  readonly method: string;
  readonly url: string;
  terminal: boolean;
}

function errorObject(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function errorText(error: unknown): string {
  return errorObject(error).message;
}

function fail(
  outcome: HttpOperationOutcome,
  reason: HttpTerminalReason,
  error: unknown,
): Error {
  const result = errorObject(error);
  if (!httpFailures.has(result)) httpFailures.set(result, { outcome, reason });
  return result;
}

function traceTerminal(
  trace: HttpTraceOperation,
  outcome: 'completed' | HttpOperationOutcome,
  reason: 'response_complete' | HttpTerminalReason,
  error?: unknown,
): void {
  if (trace.terminal) return;
  trace.terminal = true;
  log.trace(() => [
    'http_terminal method=%j url=%j outcome=%s reason=%s%s elapsedMs=%d',
    trace.method,
    trace.url,
    outcome,
    reason,
    error === undefined ? '' : ` error=${JSON.stringify(errorText(error))}`,
    Date.now() - trace.startedAt,
  ]);
}

const SENSITIVE_REDIRECT_HEADERS = new Set([
  'authorization',
  'cookie',
  'cookie2',
  'host',
  'proxy-authorization',
]);

function headersForRedirect(
  headers: Record<string, string>,
  source: URL,
  target: URL,
): Record<string, string> {
  if (source.origin === target.origin) return headers;
  return Object.fromEntries(
    Object.entries(headers)
      .filter(([name]) => !SENSITIVE_REDIRECT_HEADERS.has(name.toLowerCase())),
  );
}

export class RequestUtil {
  // Collect Set-Cookie across the ptlogin2 jump's redirect chain. NEVER hangs:
  // a per-request timeout + a redirect-depth cap guarantee termination, and any
  // failed/slow hop resolves with the cookies gathered so far rather than
  // throwing. This matters because the jump's final hop can target a host the
  // deployment can't reach (e.g. a datacenter网络 that times out on
  // qzone.qq.com) — without the ceiling that would hang every cookie-backed web
  // action forever (the essential cookies are already set by the first hop).
  static async HttpsGetCookies(url: string, depth = 0): Promise<{ [key: string]: string; }> {
    const startedAt = Date.now();
    return runWithTraceRequest(async () => {
      const cookies: Record<string, string> = {};
      log.trace('http_cookie_start url=%j depth=%d', url, depth);
      let result: CookieCollectionResult;
      try {
        result = await this.collectCookies(url, depth, cookies);
      } catch (error) {
        result = { reason: 'transport_failure', error: errorObject(error) };
      }
      log.trace(() => [
        'http_cookie_terminal url=%j outcome=completed reason=%s failOpen=%s cookies=%s%s elapsedMs=%d',
        url,
        result.reason,
        result.reason !== 'response_complete',
        renderParamsVerbose(cookies),
        result.error === undefined ? '' : ` error=${JSON.stringify(errorText(result.error))}`,
        Date.now() - startedAt,
      ]);
      return cookies;
    });
  }

  private static collectCookies(
    url: string,
    depth: number,
    cookies: Record<string, string>,
  ): Promise<CookieCollectionResult> {
    const client = url.startsWith('https') ? https : http;
    return new Promise((resolve) => {
      let settled = false;
      let traceResponseDeadline: (() => void) | undefined;
      const done = (reason: CookieTerminalReason, error?: unknown) => {
        if (settled) return;
        settled = true;
        resolve({
          reason,
          ...(error === undefined ? {} : { error: errorObject(error) }),
        });
      };
      const req = client.get(url, (res) => {
        if (res.headers['set-cookie']) {
          this.extractCookies(res.headers['set-cookie'], cookies);
        }
        log.trace(() => [
          'http_cookie_response url=%j status=%s headers=%s cookies=%s',
          url,
          res.statusCode ?? 'unknown',
          renderParamsVerbose(res.headers),
          renderParamsVerbose(cookies),
        ]);
        const traceChunks: Buffer[] | null = getLogLevel() === 'trace' ? [] : null;
        let traceResponseBytes = 0;
        let bodyTraced = false;
        const traceBody = (state: 'complete' | 'aborted' | 'error' | 'deadline') => {
          if (bodyTraced) return;
          bodyTraced = true;
          if (traceChunks === null) return;
          const body = Buffer.concat(traceChunks, traceResponseBytes);
          log.trace(() => [
            'http_cookie_body url=%j state=%s bodyBytes=%d bodyHex=%s body=%j',
            url,
            state,
            traceResponseBytes,
            renderTraceBytes(body),
            body.toString(),
          ]);
        };
        traceResponseDeadline = () => traceBody('deadline');
        res.on('data', (chunk: string | Buffer) => {
          if (traceChunks === null) return;
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          traceResponseBytes += bytes.length;
          traceChunks.push(bytes);
        });
        res.once('aborted', () => {
          traceBody('aborted');
          done('transport_failure', new Error('cookie response aborted before completion'));
        });
        res.once('error', (error: Error) => {
          traceBody('error');
          done('transport_failure', error);
        });
        res.on('end', () => {
          traceBody('complete');
          const location = res.headers.location;
          if ((res.statusCode === 301 || res.statusCode === 302) && location) {
            if (depth >= 5) {
              done('redirect_limit');
              return;
            }
            let redirectUrl: string;
            try {
              redirectUrl = new URL(location, url).href;
            } catch {
              done('redirect_failure');
              return;
            }
            log.trace(() => [
              'http_cookie_branch branch=redirect status=%d from=%j to=%j cookies=%s remainingRedirects=%d',
              res.statusCode,
              url,
              redirectUrl,
              renderParamsVerbose(cookies),
              5 - depth,
            ]);
            this.collectCookies(redirectUrl, depth + 1, cookies)
              .then((result) => {
                if (settled) return;
                settled = true;
                resolve(result);
              })
              .catch((error) => done('transport_failure', error));
            return;
          }
          done('response_complete');
        });
      });
      req.setTimeout(8000, () => {
        traceResponseDeadline?.();
        req.destroy();
        done('deadline');
      });
      req.on('error', (error) => done('transport_failure', error));
    });
  }

  private static extractCookies(setCookieHeaders: string[], cookies: { [key: string]: string; }) {
    setCookieHeaders.forEach((cookie) => {
      const parts = cookie.split(';')[0]?.split('=');
      if (parts) {
        const key = parts[0];
        const value = parts[1];
        if (key && value && key.length > 0 && value.length > 0) {
          cookies[key] = value;
        }
      }
    });
  }

  static async HttpGetJson<T>(url: string, method: string = 'GET', data?: RequestBody, headers: {
    [key: string]: string;
  } = {}, isJsonRet: boolean = true, isArgJson: boolean = true, maxRedirects: number = 5,
  responseLimits: HttpResponseLimits = {}): Promise<T> {
    const methodName = method.toUpperCase();
    const trace: HttpTraceOperation = {
      startedAt: Date.now(),
      method: methodName,
      url,
      terminal: false,
    };

    return runWithTraceRequest(async () => {
      log.trace(() => [
        'http_start method=%j url=%j headers=%s data=%s responseType=%s timeoutMs=%s maxResponseBytes=%s',
        methodName,
        url,
        renderParamsVerbose(headers),
        renderParamsVerbose(data),
        isJsonRet ? 'json' : 'text',
        responseLimits.timeoutMs ?? 'none',
        responseLimits.maxResponseBytes ?? 'none',
      ]);

      try {
        try {
          validateLimit('timeoutMs', responseLimits.timeoutMs);
          validateLimit('maxResponseBytes', responseLimits.maxResponseBytes);
        } catch (error) {
          throw fail('failed', 'request_invalid', error);
        }
        const value = await this.request<T>({
          url,
          method: methodName,
          data,
          headers,
          isJsonRet,
          isArgJson,
          maxRedirects,
          responseLimits,
          deadlineAt: responseLimits.timeoutMs === undefined
            ? undefined
            : Date.now() + responseLimits.timeoutMs,
        });
        traceTerminal(trace, 'completed', 'response_complete');
        return value;
      } catch (error: unknown) {
        const result = errorObject(error);
        const classification = httpFailures.get(result) ?? {
          outcome: 'failed' as const,
          reason: 'transport_failure' as const,
        };
        traceTerminal(
          trace,
          classification.outcome,
          classification.reason,
          result,
        );
        throw result;
      }
    });
  }

  private static async request<T>(context: HttpRequestContext): Promise<T> {
    let option: URL;
    try {
      option = new URL(context.url);
    } catch (error) {
      throw fail('failed', 'request_invalid', error);
    }
    const protocol = option.protocol === 'https:'
      ? https
      : option.protocol === 'http:'
        ? http
        : undefined;
    if (!protocol) {
      throw fail(
        'failed',
        'request_invalid',
        new Error(`unsupported request protocol: ${option.protocol}`),
      );
    }

    const remainingTimeoutMs = context.deadlineAt === undefined
      ? undefined
      : context.deadlineAt - Date.now();
    if (remainingTimeoutMs !== undefined && remainingTimeoutMs <= 0) {
      throw fail(
        'timeout',
        'deadline',
        new Error(`request timed out after ${context.responseLimits.timeoutMs} ms`),
      );
    }

    const options = {
      hostname: option.hostname,
      port: option.port,
      path: option.pathname + option.search,
      method: context.method,
      headers: context.headers,
    };

    return new Promise((resolve, reject) => {
      let settled = false;
      let timeout: NodeJS.Timeout | undefined;
      let traceResponseFailure: ((
        state: 'aborted' | 'deadline' | 'error' | 'too_large',
      ) => void) | undefined;
      const clearDeadline = () => {
        if (timeout !== undefined) clearTimeout(timeout);
      };
      const resolveOnce = (value: T) => {
        if (settled) return;
        settled = true;
        clearDeadline();
        resolve(value);
      };
      const rejectOnce = (error: Error) => {
        if (settled) return;
        settled = true;
        clearDeadline();
        reject(error);
      };
      const handOff = (next: Promise<T>) => {
        if (settled) return;
        settled = true;
        clearDeadline();
        next.then(resolve).catch(reject);
      };

      let req: http.ClientRequest;
      try {
        req = protocol.request(options, (res: http.IncomingMessage) => {
          const statusCode = res.statusCode ?? 0;
          const closeCurrent = () => {
            res.destroy();
            req.destroy();
          };
          res.once('error', (error: Error) => {
            traceResponseFailure?.('error');
            rejectOnce(fail('failed', 'transport_failure', error));
          });
          res.once('aborted', () => {
            traceResponseFailure?.('aborted');
            rejectOnce(fail(
              'cancelled',
              'response_aborted',
              new Error('response aborted before completion'),
            ));
          });

          if ((statusCode === 301 || statusCode === 302 || statusCode === 307 || statusCode === 308) && res.headers.location) {
            log.trace(() => [
              'http_response status=%d url=%j headers=%s bodyState=not_read',
              statusCode,
              context.url,
              renderParamsVerbose(res.headers),
            ]);
            if (context.maxRedirects <= 0) {
              rejectOnce(fail('failed', 'redirect_failure', new Error('Too many redirects')));
              closeCurrent();
              return;
            }

            let redirectUrl: URL;
            try {
              redirectUrl = new URL(res.headers.location, option);
            } catch (error) {
              rejectOnce(fail(
                'failed',
                'redirect_failure',
                new Error('invalid redirect location', { cause: error }),
              ));
              closeCurrent();
              return;
            }
            if (redirectUrl.protocol !== 'http:' && redirectUrl.protocol !== 'https:') {
              rejectOnce(fail(
                'failed',
                'redirect_failure',
                new Error(`unsupported redirect protocol: ${redirectUrl.protocol}`),
              ));
              closeCurrent();
              return;
            }
            if (option.origin !== redirectUrl.origin
            && context.method.toUpperCase() !== 'GET'
            && context.method.toUpperCase() !== 'HEAD') {
              rejectOnce(fail(
                'failed',
                'redirect_failure',
                new Error(
                  `cross-origin redirect cannot forward method ${context.method.toUpperCase()}`,
                ),
              ));
              closeCurrent();
              return;
            }

            const redirectHeaders = headersForRedirect(context.headers, option, redirectUrl);
            log.trace(() => [
              'http_branch branch=redirect status=%d from=%j to=%j nextHeaders=%s remainingRedirects=%d',
              statusCode,
              context.url,
              redirectUrl.href,
              renderParamsVerbose(redirectHeaders),
              context.maxRedirects - 1,
            ]);
            handOff(this.request<T>({
              ...context,
              url: redirectUrl.href,
              headers: redirectHeaders,
              maxRedirects: context.maxRedirects - 1,
            }));
            closeCurrent();
            return;
          }

          if (statusCode < 200 || statusCode >= 300) {
            log.trace(() => [
              'http_response status=%d url=%j headers=%s bodyState=not_read',
              statusCode,
              context.url,
              renderParamsVerbose(res.headers),
            ]);
            rejectOnce(fail(
              'failed',
              'non_2xx',
              new Error(`Unexpected status code: ${res.statusCode}`),
            ));
            closeCurrent();
            return;
          }

          const chunks: Buffer[] = [];
          let responseBytes = 0;
          let failureBodyTraced = false;
          traceResponseFailure = (state) => {
            if (failureBodyTraced) return;
            failureBodyTraced = true;
            log.trace(() => {
              const observedBody = Buffer.concat(chunks, responseBytes);
              return [
                'http_response status=%d url=%j headers=%s bodyState=%s bodyBytes=%d bodyHex=%s body=%j',
                statusCode,
                context.url,
                renderParamsVerbose(res.headers),
                state,
                responseBytes,
                renderTraceBytes(observedBody),
                observedBody.toString(),
              ];
            });
          };
          res.on('data', (chunk: string | Buffer) => {
            if (settled) return;
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            responseBytes += bytes.length;
            chunks.push(bytes);
            if (context.responseLimits.maxResponseBytes !== undefined
            && responseBytes > context.responseLimits.maxResponseBytes) {
              traceResponseFailure?.('too_large');
              const error = fail(
                'failed',
                'response_too_large',
                new Error(
                  `response body exceeds ${context.responseLimits.maxResponseBytes} bytes`,
                ),
              );
              rejectOnce(error);
              closeCurrent();
              return;
            }
          });

          res.on('end', () => {
            if (settled) return;
            failureBodyTraced = true;
            const responseBuffer = Buffer.concat(chunks, responseBytes);
            const responseBody = responseBuffer.toString();
            log.trace(() => [
              'http_response status=%d url=%j headers=%s bodyBytes=%d bodyHex=%s body=%j',
              statusCode,
              context.url,
              renderParamsVerbose(res.headers),
              responseBytes,
              renderTraceBytes(responseBuffer),
              responseBody,
            ]);
            try {
              if (context.isJsonRet) {
                const parsed = JSON.parse(responseBody) as T;
                log.trace(() => [
                  'http_branch branch=parse_completed responseType=json result=%s',
                  renderParamsVerbose(parsed),
                ]);
                resolveOnce(parsed);
              } else {
                log.trace('http_branch branch=parse_completed responseType=text');
                resolveOnce(responseBody as T);
              }
            } catch (parseError: unknown) {
              log.trace(() => [
                'http_branch branch=parse_failed responseType=json error=%j',
                errorText(parseError),
              ]);
              rejectOnce(fail('failed', 'parse_failure', parseError));
            }
          });
        });
      } catch (error) {
        rejectOnce(fail('failed', 'request_invalid', error));
        return;
      }

      if (remainingTimeoutMs !== undefined) {
        timeout = setTimeout(() => {
          traceResponseFailure?.('deadline');
          const error = new Error(
            `request timed out after ${context.responseLimits.timeoutMs} ms`,
          );
          rejectOnce(fail('timeout', 'deadline', error));
          req.destroy();
        }, remainingTimeoutMs);
      }

      req.on('error', (error: Error) => rejectOnce(
        fail('failed', 'transport_failure', error),
      ));
      try {
        if (context.method === 'POST' || context.method === 'PUT' || context.method === 'PATCH') {
          const requestBody = context.isArgJson
            ? JSON.stringify(context.data)
            : context.data;
          if (typeof requestBody === 'string'
            || Buffer.isBuffer(requestBody)
            || requestBody instanceof Uint8Array) {
            log.trace(() => {
              const requestBytes = typeof requestBody === 'string'
                ? Buffer.from(requestBody)
                : requestBody;
              return [
                'http_branch branch=request_body url=%j requestBytes=%d requestHex=%s',
                context.url,
                requestBytes.byteLength,
                renderTraceBytes(requestBytes),
              ];
            });
          }
          req.write(requestBody);
        }
        req.end();
      } catch (error) {
        rejectOnce(fail('failed', 'request_invalid', error));
        req.destroy();
      }
    });
  }

  static async HttpGetText(
    url: string,
    method: string = 'GET',
    data?: RequestBody,
    headers: { [key: string]: string; } = {},
    responseLimits: HttpResponseLimits = {},
  ) {
    return this.HttpGetJson<string>(
      url,
      method,
      data,
      headers,
      false,
      false,
      5,
      responseLimits,
    );
  }
}

export function cookieToString(cookieObject: Record<string, string>): string {
  return Object.entries(cookieObject)
    .map(([key, value]) => `${key}=${value}`)
    .join('; ');
}


export function getBknFromCookie(cookieObject: Record<string, string>): string {
  const skey = cookieObject['p_skey'] || cookieObject['skey'] || '';
  let hash = 5381;
  for (let i = 0; i < skey.length; i++) {
    hash += (hash << 5) + skey.charCodeAt(i);
  }
  return (hash & 2147483647).toString();
}
