import { afterEach, describe, expect, it } from 'vitest';
import {
  createLogger,
  currentRequestId,
  getLogLevel,
  nextRequestId,
  renderTraceBytes,
  runWithRequestId,
  runWithTraceRequest,
  setLogLevel,
} from '../src/logger';

const originalLevel = getLogLevel();

afterEach(() => {
  setLogLevel(originalLevel);
});

describe('TRACE diagnostics contract', () => {
  it('renders every byte as continuous lowercase hexadecimal', () => {
    expect(renderTraceBytes(new Uint8Array())).toBe('');
    expect(renderTraceBytes(new Uint8Array([0x00, 0x01, 0x0f, 0x10, 0xff])))
      .toBe('00010f10ff');
  });

  it('renders only the addressed Uint8Array view', () => {
    const backing = new Uint8Array([0xaa, 0x00, 0x0f, 0xff, 0xbb]);

    expect(renderTraceBytes(backing.subarray(1, 4))).toBe('000fff');
    expect(renderTraceBytes(Buffer.from(backing.buffer).subarray(2, 4))).toBe('0fff');
  });

  it('does not render bytes while TRACE is disabled', () => {
    setLogLevel('info');
    let rendered = false;

    createLogger('Trace.Contract').trace(() => {
      rendered = true;
      return ['body=%s', renderTraceBytes(new Uint8Array([0xff]))];
    });

    expect(rendered).toBe(false);
  });

  it('creates distinct request contexts that survive asynchronous work', async () => {
    setLogLevel('info');
    const beforeDisabled = nextRequestId();
    expect(runWithTraceRequest(() => currentRequestId())).toBeUndefined();
    const afterDisabled = nextRequestId();
    expect(afterDisabled).toBe(beforeDisabled + 1);

    setLogLevel('trace');
    const observeContext = () => runWithTraceRequest(async () => {
      const before = currentRequestId();
      await Promise.resolve();
      const after = currentRequestId();
      expect(after).toBe(before);
      return after;
    });

    const first = await observeContext();
    expect(currentRequestId()).toBeUndefined();
    const second = await observeContext();
    expect(currentRequestId()).toBeUndefined();

    expect(first).toEqual(expect.any(Number));
    expect(first).toBeGreaterThan(0);
    expect(second).toEqual(expect.any(Number));
    expect(second).toBeGreaterThan(0);
    expect(second).not.toBe(first);
  });

  it('allocates once for nested TRACE contexts and reuses the request id', () => {
    setLogLevel('trace');
    const before = nextRequestId();

    const observed = runWithTraceRequest(() => {
      const outer = currentRequestId();
      const inner = runWithTraceRequest(() => currentRequestId());
      return { outer, inner };
    });

    const after = nextRequestId();
    expect(observed.outer).toEqual(expect.any(Number));
    expect(observed.inner).toBe(observed.outer);
    expect(observed.outer).toBe(before + 1);
    expect(after).toBe(before + 2);
    expect(currentRequestId()).toBeUndefined();
  });

  it('reuses an existing request context even while TRACE is disabled', async () => {
    setLogLevel('info');

    await runWithRequestId(4242, async () => {
      const observed = await runWithTraceRequest(async () => {
        await Promise.resolve();
        return currentRequestId();
      });
      expect(observed).toBe(4242);
    });
  });
});
