// Shared QQ UIN validity check. A "real" UIN is a live QQ account number, not
// a garbage value the native hook can emit during the probe→inject race — e.g.
// a 13-digit millisecond timestamp read from not-yet-populated QQ memory
// (issue #162). No real QQ UIN exceeds 10 digits (they fit in uint32, max
// 4294967295), so a pure digit string of 5..10 chars is the accept window.
//
// Callers rely on a `true` result guaranteeing a BigInt()-safe pure-digit
// string. Keep that contract if the pattern ever changes.
export function isRealUin(uin: string): boolean {
  return /^\d{5,10}$/.test(uin);
}
