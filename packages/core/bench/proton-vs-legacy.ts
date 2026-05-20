// Proton vs legacy runtime ProtoSchema encoder/decoder benchmark.
//
// Compares the codec functions generated at build time by @snowluma/proton
// against the runtime schema-walking implementation in src/protobuf/decode.ts,
// using the actual long-message schemas already in the codebase.
//
// Methodology:
//   - Proton codecs are produced by calling its `analyzeSource` + `generateCode`
//     API on the existing proto/proton/longmsg.ts source file, then `new
//     Function`-eval'd into a callable. This is identical to what the Vite
//     plugin does at build time, minus the file-replacement step.
//   - Legacy codecs are the existing `protoEncode` / `protoDecode` functions
//     called against the existing `*Schema` constants.
//   - Each measurement does 2 000 warmup iterations, then N timed iterations.
//   - Operation cost is reported as ops/sec and ns/op. The first row's
//     ops/sec is the relative baseline.
//
// Run:
//   pnpm --filter @snowluma/core exec tsx bench/proton-vs-legacy.ts

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { analyzeSource, generateCode } from '@snowluma/proton/vite';
import { protoEncode, protoDecode } from '../src/protobuf/decode';
import {
  LongMsgSettingsSchema,
  SendLongMsgRespSchema,
  SendLongMsgReqSchema,
  RecvLongMsgRespSchema,
} from '../src/bridge/proto/longmsg';

// ── proton codec materialisation ─────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const protonSchemaPath = resolve(__dirname, '..', 'src', 'bridge', 'proto', 'proton', 'longmsg.ts');
const protonSchemaSource = readFileSync(protonSchemaPath, 'utf-8');

function materialiseProton(messageNames: readonly string[]): Record<string, { encode: (o: unknown) => Uint8Array; decode: (b: Uint8Array) => unknown }> {
  // Append synthetic call sites so the registry actually contains the messages
  // we want — `selectUsedRegistry` only retains call-site roots, and the
  // proton/longmsg.ts source itself has no `protobuf_encode` calls.
  const callSites = messageNames
    .map((n) => `protobuf_encode<${n}>({} as any); protobuf_decode<${n}>(new Uint8Array());`)
    .join('\n');
  const sourceWithCallSites = protonSchemaSource + `\n\n// synthetic call sites for bench codegen\n` + callSites;

  const registry = analyzeSource(sourceWithCallSites, protonSchemaPath);
  const code = generateCode(registry);
  const factoryBody = `
    ${code}
    const out = {};
    ${messageNames.map(n => `out.${n} = { encode: protobuf_encode_${n}, decode: protobuf_decode_${n} };`).join('\n')}
    return out;
  `;
  return new Function(factoryBody)() as Record<string, { encode: (o: unknown) => Uint8Array; decode: (b: Uint8Array) => unknown }>;
}

const proton = materialiseProton([
  'LongMsgSettings',
  'SendLongMsgResp',
  'SendLongMsgReq',
  'RecvLongMsgResp',
]);

// ── bench harness ────────────────────────────────────────────────────

interface BenchResult { name: string; opsPerSec: number; nsPerOp: number; }

function bench(name: string, fn: () => void, iterations: number): BenchResult {
  for (let i = 0; i < 2000; i++) fn();
  const start = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  const ms = performance.now() - start;
  return {
    name,
    opsPerSec: Math.round((iterations / ms) * 1000),
    nsPerOp: Math.round((ms / iterations) * 1_000_000),
  };
}

function printSection(title: string, results: BenchResult[]) {
  console.log(`\n## ${title}`);
  console.log('| Encoder    |     ops/sec |  ns/op | relative |');
  console.log('|------------|-------------|--------|----------|');
  const baseline = results[0].opsPerSec;
  for (const r of results) {
    const rel = r.opsPerSec / baseline;
    const relStr = r === results[0] ? '1.00×' : `${rel.toFixed(2)}×`;
    console.log(
      `| ${r.name.padEnd(10)} | ${r.opsPerSec.toLocaleString().padStart(11)} | ${String(r.nsPerOp).padStart(6)} | ${relStr.padStart(8)} |`,
    );
  }
}

// ── workloads ────────────────────────────────────────────────────────

const settingsObj = { field1: 4, field2: 1, field3: 7, field4: 2 };

const sendRespObj = { result: { resId: 'res-001' } };

const sendReqObj = {
  info: {
    type: 1,
    uid: { uid: 'u_test' },
    groupUin: 123456,
    payload: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
  },
  settings: { field1: 4, field2: 1, field3: 7, field4: 2 },
};

const recvRespObj = {
  result: { resId: 'r-1', payload: new Uint8Array(64).fill(0x42) },
  settings: { field1: 4, field2: 1, field3: 7, field4: 2 },
};

// Pre-encoded bytes for decode benches (use proton output so both sides see
// identical, proto3-conforming input).
const settingsBytes = proton.LongMsgSettings.encode(settingsObj);
const sendRespBytes = proton.SendLongMsgResp.encode(sendRespObj);
const sendReqBytes  = proton.SendLongMsgReq.encode(sendReqObj);
const recvRespBytes = proton.RecvLongMsgResp.encode(recvRespObj);

// ── run ──────────────────────────────────────────────────────────────

console.log('# @snowluma/proton vs legacy runtime benchmark\n');
console.log(`Node ${process.version} | ${process.platform} ${process.arch}`);
console.log(`Date: ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`);

const N = 300_000;

printSection('Encode — LongMsgSettings (4× uint32)', [
  { ...bench('proton', () => proton.LongMsgSettings.encode(settingsObj), N) },
  { ...bench('legacy', () => protoEncode(settingsObj, LongMsgSettingsSchema), N) },
]);

printSection('Decode — LongMsgSettings (4× uint32)', [
  { ...bench('proton', () => proton.LongMsgSettings.decode(settingsBytes), N) },
  { ...bench('legacy', () => protoDecode(settingsBytes, LongMsgSettingsSchema), N) },
]);

printSection('Encode — SendLongMsgResp (1 nested message, 1 string)', [
  { ...bench('proton', () => proton.SendLongMsgResp.encode(sendRespObj), N) },
  { ...bench('legacy', () => protoEncode(sendRespObj, SendLongMsgRespSchema), N) },
]);

printSection('Decode — SendLongMsgResp', [
  { ...bench('proton', () => proton.SendLongMsgResp.decode(sendRespBytes), N) },
  { ...bench('legacy', () => protoDecode(sendRespBytes, SendLongMsgRespSchema), N) },
]);

printSection('Encode — SendLongMsgReq (deeply nested, bytes + uint32 + string)', [
  { ...bench('proton', () => proton.SendLongMsgReq.encode(sendReqObj), N) },
  { ...bench('legacy', () => protoEncode(sendReqObj, SendLongMsgReqSchema), N) },
]);

printSection('Decode — SendLongMsgReq', [
  { ...bench('proton', () => proton.SendLongMsgReq.decode(sendReqBytes), N) },
  { ...bench('legacy', () => protoDecode(sendReqBytes, SendLongMsgReqSchema), N) },
]);

printSection('Encode — RecvLongMsgResp (64-byte payload + settings)', [
  { ...bench('proton', () => proton.RecvLongMsgResp.encode(recvRespObj), N) },
  { ...bench('legacy', () => protoEncode(recvRespObj, RecvLongMsgRespSchema), N) },
]);

printSection('Decode — RecvLongMsgResp', [
  { ...bench('proton', () => proton.RecvLongMsgResp.decode(recvRespBytes), N) },
  { ...bench('legacy', () => protoDecode(recvRespBytes, RecvLongMsgRespSchema), N) },
]);

console.log('');
