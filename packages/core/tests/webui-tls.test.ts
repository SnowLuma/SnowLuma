import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { validateTlsPair, resolveTlsContext } from '../src/webui/tls';

// A throwaway self-signed pair (openssl, CN=snowluma-test). createSecureContext
// only parses — expiry is irrelevant — so this stays valid for the test forever.
const CERT = `-----BEGIN CERTIFICATE-----
MIIDETCCAfmgAwIBAgIUNiu66PmcO6Do6cUaB92UKD8j3qYwDQYJKoZIhvcNAQEL
BQAwGDEWMBQGA1UEAwwNc25vd2x1bWEtdGVzdDAeFw0yNjA2MTgwNjIwMTZaFw0z
NjA2MTUwNjIwMTZaMBgxFjAUBgNVBAMMDXNub3dsdW1hLXRlc3QwggEiMA0GCSqG
SIb3DQEBAQUAA4IBDwAwggEKAoIBAQCm0sVJhqlG75gOFJVsUJOfR+oqvb9eSq4t
k5QItuwXr85E2mrzuKFnSzVVbi3VqqyN8t4otL11mGll2ANSjusmWN4hzpaOBBdX
bP4UNX/YA7oHId+QKbVicxJgxDE18aPTwaWullyw23LsMsij8T4nLk4eHiOkeRfi
uLinG1COe3gUGkCK4uyyMT4Vz+y+5Oj9dvoXYL/A/KmcNtq7JrX7F7qYnYsJKLZZ
aZeFyIGSE8ihb0k53iyJ3agWY+rMUD+p5J7pgIZzBd5dcZuI+KwixVKZgapG5n5R
ghrnN2ZAQFz13yTRXYmDYy42m4Ue73hMmmt1xVXyf+WVhvrD6pphAgMBAAGjUzBR
MB0GA1UdDgQWBBRW/HP12nj9fYMYNxa3jyqmnUigvTAfBgNVHSMEGDAWgBRW/HP1
2nj9fYMYNxa3jyqmnUigvTAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUA
A4IBAQCijzVQ/jHNoqu6stvkkigUv2lTKrd1EHcTZLfzwQkmNv/hfY2EMobO/Qxs
FhmITreKFALJ/dUwTt0UTO00LV9whEgr2of4x8wwjZ9wRstY6uyRYBP85QC8+8mZ
zWlcf611HugrmpOWjWfEVmmxdI1m26YWTn52nZFPnJqDWg2+RlLJWl55lVotbXEZ
Fvas4Vcf2KOk0QwBQKvpt0BISeTIQhbT4GnducxSxyoXGeBQOjQNYb/vTpMn4F9U
IAxSsfs9WVoHKXOabK8GV89BCxWoRk4UaSahTq/2Vnbgt86tWibt3lA4y49+XhA2
6z7n9HgJAUKqhsDrYvZmM7/VZ2d5
-----END CERTIFICATE-----
`;
const KEY = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCm0sVJhqlG75gO
FJVsUJOfR+oqvb9eSq4tk5QItuwXr85E2mrzuKFnSzVVbi3VqqyN8t4otL11mGll
2ANSjusmWN4hzpaOBBdXbP4UNX/YA7oHId+QKbVicxJgxDE18aPTwaWullyw23Ls
Msij8T4nLk4eHiOkeRfiuLinG1COe3gUGkCK4uyyMT4Vz+y+5Oj9dvoXYL/A/Kmc
Ntq7JrX7F7qYnYsJKLZZaZeFyIGSE8ihb0k53iyJ3agWY+rMUD+p5J7pgIZzBd5d
cZuI+KwixVKZgapG5n5RghrnN2ZAQFz13yTRXYmDYy42m4Ue73hMmmt1xVXyf+WV
hvrD6pphAgMBAAECggEAJ13+u4qhIMHCnrQBzPU42PImEt8DLXOvJcc5PFM6ZJ6S
rRHkAk60HAWV+OqOu2jS3o6NGYsJWJpWaPewVQev+zUmelDfm3TgsztfvBIh8K50
dGFsef81tB1WnWo++K1kzUBZ4ljOV9f5hz62tWVlFubo/Vd8bsA6wEB6Jskd2fls
ZOO0hJCb/M6IIwe3cWw4sb/YFTTLMUnVHM0aJfnQ/QH+uraRwecJMv118d0YBYVG
DsNmYqrv9TYNBh4P9mKv6/0x8zaKsJZVLAMwHztILHItOXBfxCbSDivGWVUGiDq2
NxEuBOgxzOelxEYzUzf7B6sjHoEeIL5wIKQbwUbmfwKBgQDZRLhucrMZPw7ous1t
igkO32p1ku7FRxm0/JAskc66oX61KLIYbZFM9N7nTXAEs8ZGhzUkdSgxNcdHWIdK
RI+6pd2FhhcKU1feEohlOHvZTXXEMhm61phWnN391GZXfwMKSpscqsu9kIix2jtw
4YrzKLx82EDDHcLfBh9AtArKywKBgQDEj+7UJp5wuqz9hj+gogXeq4Buv9be1u4u
HCJZMZzLCwVjvoqYw0n1afXP3057v8hQPGsBaxzQpOg7i1lYGGfuZ9T6T8fFrtqw
m/LJLHhMQxeyCEQi1/EoNewvVGSwBJkLOuOs8T2WmMXmOgdHbEYdzkKtT71jst6y
TeJ15hVuAwKBgBMK4t9LTkc4L6ZWOQsQvhp/mmUTq7m+sZIbUMeXP/c7kE9wcauS
btm/3ImJT/gZiZdE4nN/kTY+8GhgafsoZzCEuRWq2vocs+bS2QGGIdS55Uh826R0
ioWM2igVJaMljq6oO1AX6COFN3XfGraaDgOh3mNS0NpJEXtangKdxRRhAoGAP9SF
t/r6hJz6RDHuQ5mZ0l9bC5vciOy+19ZnCRPlWMIxc9ySYV05jSplmqVndSQoRnX4
QbOo3dBPYda0orj6Nx8cuFRkCTvo5GUgCFgakJlQ/o1UowQA2g/4rL35HHfBwzXS
bXzBhUADM+owJu9wLYmneWRlmhSh4MEOAz8+QkUCgYAw0fA1Im2/ftrA2Z2IENTi
U4cLXqeUeGJfXjIBklUmXhc4qrd/9V9eEHjackI/JI7Qhp/QfPWMXLudlSrppnNJ
+s3dVevEKosiZbf4qtTtlmR/IifuTKjK5O94KlBT+evxNsL4Hv0b0oTsVNnEfOOl
OUsvSYNSnfvl87tyLIxYLA==
-----END PRIVATE KEY-----
`;

describe('validateTlsPair', () => {
  it('accepts a matching cert/key pair', () => {
    expect(validateTlsPair(CERT, KEY)).toEqual({ ok: true });
  });

  it('rejects garbage PEM with a reason', () => {
    const r = validateTlsPair('not a cert', 'not a key');
    expect(r.ok).toBe(false);
    expect(r.reason).toBeTruthy();
  });

  it('rejects an empty cert', () => {
    expect(validateTlsPair('', KEY).ok).toBe(false);
  });
});

describe('resolveTlsContext', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-tls-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('loads cert.pem + key.pem when both present and valid', () => {
    fs.writeFileSync(path.join(dir, 'cert.pem'), CERT);
    fs.writeFileSync(path.join(dir, 'key.pem'), KEY);
    const r = resolveTlsContext(dir);
    expect(r.ok).toBe(true);
    expect(r.cert?.toString()).toContain('BEGIN CERTIFICATE');
    expect(r.key?.toString()).toContain('PRIVATE KEY');
  });

  it('fails (with reason) when files are missing', () => {
    const r = resolveTlsContext(dir);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/missing/i);
  });

  it('fails when the on-disk PEM is invalid', () => {
    fs.writeFileSync(path.join(dir, 'cert.pem'), 'garbage');
    fs.writeFileSync(path.join(dir, 'key.pem'), 'garbage');
    const r = resolveTlsContext(dir);
    expect(r.ok).toBe(false);
    expect(r.reason).toBeTruthy();
  });
});
