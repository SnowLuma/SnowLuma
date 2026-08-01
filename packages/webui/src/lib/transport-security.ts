const LOOPBACK_V4 = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u;

function isLoopbackIpv4(hostname: string): boolean {
  const match = LOOPBACK_V4.exec(hostname);
  if (!match) return false;
  return match.slice(1).every((part) => Number(part) <= 255);
}

export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/gu, '').replace(/\.$/u, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (isLoopbackIpv4(host)) return true;
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  if (host.startsWith('::ffff:')) return isLoopbackIpv4(host.slice('::ffff:'.length));
  return false;
}

export function shouldWarnAboutInsecureRemoteAccess(location: {
  protocol: string;
  hostname: string;
}): boolean {
  return location.protocol !== 'https:' && !isLoopbackHostname(location.hostname);
}
