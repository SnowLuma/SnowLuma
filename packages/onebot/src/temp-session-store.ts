/**
 * Records the group temp sessions the bot has received a message from, so a
 * reply can be limited to sessions the peer opened. Written only on the receive
 * path, read only on the send path. Keyed by `${userUin}:${groupUin}` — a user
 * may hold sessions from several groups. Entries expire after
 * {@link TEMP_SESSION_TTL_MS}.
 */

/** Reply window: 7 days after the last inbound temp message. */
export const TEMP_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export class TempSessionStore {
  /** key → expiry epoch ms. */
  private readonly sessions = new Map<string, number>();

  private static key(userUin: number, groupUin: number): string {
    return `${userUin}:${groupUin}`;
  }

  /**
   * Record (or refresh) an inbound temp session. Called from the receive path.
   * No-op without a source group (groupUin<=0) — the session stays receive-only.
   */
  record(userUin: number, groupUin: number, now: number = Date.now()): void {
    if (userUin <= 0 || groupUin <= 0) return;
    // Opportunistically prune expired entries here — `has` only removes keys it
    // reads, so a stream of never-replied sessions would otherwise grow the map
    // unbounded.
    this.sweep(now);
    this.sessions.set(TempSessionStore.key(userUin, groupUin), now + TEMP_SESSION_TTL_MS);
  }

  /** True iff a reply is allowed for this exact (user, group). Prunes on read. */
  has(userUin: number, groupUin: number, now: number = Date.now()): boolean {
    const key = TempSessionStore.key(userUin, groupUin);
    const expiresAt = this.sessions.get(key);
    if (expiresAt === undefined) return false;
    if (expiresAt <= now) {
      this.sessions.delete(key);
      return false;
    }
    return true;
  }

  /** Drop all expired entries. `has` also prunes lazily. */
  sweep(now: number = Date.now()): void {
    for (const [key, expiresAt] of this.sessions) {
      if (expiresAt <= now) this.sessions.delete(key);
    }
  }
}
