import http from 'node:http';
import https from 'node:https';

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
    const client = url.startsWith('https') ? https : http;
    return new Promise((resolve) => {
      const cookies: { [key: string]: string; } = {};
      let settled = false;
      const done = (extra?: { [key: string]: string; }) => {
        if (settled) return;
        settled = true;
        resolve(extra ? { ...cookies, ...extra } : cookies);
      };
      const req = client.get(url, (res) => {
        if (res.headers['set-cookie']) {
          this.extractCookies(res.headers['set-cookie'], cookies);
        }
        res.on('data', () => { }); // 必须消耗流
        res.on('end', () => {
          const location = res.headers.location;
          if ((res.statusCode === 301 || res.statusCode === 302) && location && depth < 5) {
            this.HttpsGetCookies(new URL(location, url).href, depth + 1)
              .then((rc) => done(rc))
              .catch(() => done());
          } else {
            done();
          }
        });
      });
      req.setTimeout(8000, () => { req.destroy(); done(); });
      req.on('error', () => done());
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
    validateLimit('timeoutMs', responseLimits.timeoutMs);
    validateLimit('maxResponseBytes', responseLimits.maxResponseBytes);

    return this.request<T>({
      url,
      method,
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
  }

  private static async request<T>(context: HttpRequestContext): Promise<T> {
    const option = new URL(context.url);
    const protocol = option.protocol === 'https:'
      ? https
      : option.protocol === 'http:'
        ? http
        : undefined;
    if (!protocol) {
      throw new Error(`unsupported request protocol: ${option.protocol}`);
    }

    const remainingTimeoutMs = context.deadlineAt === undefined
      ? undefined
      : context.deadlineAt - Date.now();
    if (remainingTimeoutMs !== undefined && remainingTimeoutMs <= 0) {
      throw new Error(`request timed out after ${context.responseLimits.timeoutMs} ms`);
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

      const req = protocol.request(options, (res: http.IncomingMessage) => {
        const closeCurrent = () => {
          res.destroy();
          req.destroy();
        };
        res.once('error', (error: Error) => rejectOnce(error));

        if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) && res.headers.location) {
          if (context.maxRedirects <= 0) {
            rejectOnce(new Error('Too many redirects'));
            closeCurrent();
            return;
          }

          let redirectUrl: URL;
          try {
            redirectUrl = new URL(res.headers.location, option);
          } catch (error) {
            rejectOnce(new Error('invalid redirect location', { cause: error }));
            closeCurrent();
            return;
          }
          if (redirectUrl.protocol !== 'http:' && redirectUrl.protocol !== 'https:') {
            rejectOnce(new Error(`unsupported redirect protocol: ${redirectUrl.protocol}`));
            closeCurrent();
            return;
          }
          if (option.origin !== redirectUrl.origin
            && context.method.toUpperCase() !== 'GET'
            && context.method.toUpperCase() !== 'HEAD') {
            rejectOnce(new Error(
              `cross-origin redirect cannot forward method ${context.method.toUpperCase()}`,
            ));
            closeCurrent();
            return;
          }

          handOff(this.request<T>({
            ...context,
            url: redirectUrl.href,
            headers: headersForRedirect(context.headers, option, redirectUrl),
            maxRedirects: context.maxRedirects - 1,
          }));
          closeCurrent();
          return;
        }

        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          rejectOnce(new Error(`Unexpected status code: ${res.statusCode}`));
          closeCurrent();
          return;
        }

        const chunks: Buffer[] = [];
        let responseBytes = 0;
        res.on('data', (chunk: string | Buffer) => {
          if (settled) return;
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          responseBytes += bytes.length;
          if (context.responseLimits.maxResponseBytes !== undefined
            && responseBytes > context.responseLimits.maxResponseBytes) {
            const error = new Error(
              `response body exceeds ${context.responseLimits.maxResponseBytes} bytes`,
            );
            rejectOnce(error);
            closeCurrent();
            return;
          }
          chunks.push(bytes);
        });

        res.on('end', () => {
          if (settled) return;
          const responseBody = Buffer.concat(chunks, responseBytes).toString();
          try {
            if (context.isJsonRet) {
              resolveOnce(JSON.parse(responseBody) as T);
            } else {
              resolveOnce(responseBody as T);
            }
          } catch (parseError: unknown) {
            rejectOnce(new Error(parseError instanceof Error ? parseError.message : String(parseError)));
          }
        });
      });

      if (remainingTimeoutMs !== undefined) {
        timeout = setTimeout(() => {
          const error = new Error(
            `request timed out after ${context.responseLimits.timeoutMs} ms`,
          );
          rejectOnce(error);
          req.destroy();
        }, remainingTimeoutMs);
      }

      req.on('error', (error: Error) => rejectOnce(error));
      if (context.method === 'POST' || context.method === 'PUT' || context.method === 'PATCH') {
        req.write(context.isArgJson ? JSON.stringify(context.data) : context.data);
      }
      req.end();
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
