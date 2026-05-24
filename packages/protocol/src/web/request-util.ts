import http from 'node:http';
import https from 'node:https';

type RequestBody = string | Buffer | Uint8Array | Record<string, unknown> | undefined;

export class RequestUtil {
  static async HttpsGetCookies(url: string): Promise<{ [key: string]: string; }> {
    const client = url.startsWith('https') ? https : http;
    return new Promise((resolve, reject) => {
      const req = client.get(url, (res) => {
        const cookies: { [key: string]: string; } = {};

        res.on('data', () => { }); // 必须消耗流
        res.on('end', () => {
          this.handleRedirect(res, url, cookies)
            .then(resolve)
            .catch(reject);
        });

        if (res.headers['set-cookie']) {
          this.extractCookies(res.headers['set-cookie'], cookies);
        }
      });

      req.on('error', (error: Error) => {
        reject(error);
      });
    });
  }

  private static async handleRedirect(res: http.IncomingMessage, url: string, cookies: { [key: string]: string; }): Promise<{ [key: string]: string; }> {
    if (res.statusCode === 301 || res.statusCode === 302) {
      if (res.headers.location) {
        const redirectUrl = new URL(res.headers.location, url);
        const redirectCookies = await this.HttpsGetCookies(redirectUrl.href);
        return { ...cookies, ...redirectCookies };
      }
    }
    return cookies;
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
  } = {}, isJsonRet: boolean = true, isArgJson: boolean = true, maxRedirects: number = 5): Promise<T> {
    const option = new URL(url);
    const protocol = url.startsWith('https://') ? https : http;
    const options = {
      hostname: option.hostname,
      port: option.port,
      path: option.pathname + option.search,
      method,
      headers,
    };

    return new Promise((resolve, reject) => {
      const req = protocol.request(options, (res: http.IncomingMessage) => {
        if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) && res.headers.location) {
          if (maxRedirects <= 0) {
            reject(new Error('Too many redirects'));
            return;
          }
          const redirectUrl = new URL(res.headers.location, url).href;
          this.HttpGetJson<T>(redirectUrl, method, data, headers, isJsonRet, isArgJson, maxRedirects - 1)
            .then(resolve)
            .catch(reject);
          return;
        }

        let responseBody = '';
        res.on('data', (chunk: string | Buffer) => { responseBody += chunk.toString(); });

        res.on('end', () => {
          try {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              if (isJsonRet) {
                resolve(JSON.parse(responseBody) as T);
              } else {
                resolve(responseBody as T);
              }
            } else {
              reject(new Error(`Unexpected status code: ${res.statusCode}`));
            }
          } catch (parseError: unknown) {
            reject(new Error(parseError instanceof Error ? parseError.message : String(parseError)));
          }
        });
      });

      req.on('error', (error: Error) => reject(error));
      if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
        req.write(isArgJson ? JSON.stringify(data) : data);
      }
      req.end();
    });
  }

  static async HttpGetText(url: string, method: string = 'GET', data?: RequestBody, headers: { [key: string]: string; } = {}) {
    return this.HttpGetJson<string>(url, method, data, headers, false, false);
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
