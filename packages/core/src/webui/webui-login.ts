import { decideSecondFactorLogin, type TotpPersistedState } from './totp';

export interface WebuiLoginAuth {
  verify(password: string): boolean;
  totpEnabled(): boolean;
  totpState(): TotpPersistedState | undefined;
  mustChangePassword(): boolean;
}

export type WebuiLoginResult =
  | { kind: 'bad-request' }
  | { kind: 'bad-password' }
  | { kind: 'needs-totp' }
  | { kind: 'bad-second-factor' }
  | { kind: 'ok'; mustChangePassword: boolean; totpState?: TotpPersistedState };

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function completeWebuiLogin(auth: WebuiLoginAuth, body: unknown, atMs: number): WebuiLoginResult {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { kind: 'bad-request' };
  }
  const record = body as Record<string, unknown>;
  const password = readString(record.password);
  if (!auth.verify(password)) {
    return { kind: 'bad-password' };
  }
  const decision = decideSecondFactorLogin({
    totpEnabled: auth.totpEnabled(),
    state: auth.totpState(),
    password,
    totp: readString(record.totp) || undefined,
    recoveryCode: readString(record.recoveryCode) || undefined,
    atMs,
  });
  if (decision.kind === 'needs-totp') return { kind: 'needs-totp' };
  if (decision.kind === 'bad-second-factor') return { kind: 'bad-second-factor' };
  return {
    kind: 'ok',
    mustChangePassword: auth.mustChangePassword(),
    ...(decision.state ? { totpState: decision.state } : {}),
  };
}

export function invalidateOtherSessions<T>(sessions: Map<string, T>, keepToken: string): void {
  for (const token of sessions.keys()) {
    if (token !== keepToken) sessions.delete(token);
  }
}
