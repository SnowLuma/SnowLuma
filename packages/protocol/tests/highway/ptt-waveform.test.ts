import { describe, expect, it } from 'vitest';
import { protobuf_decode } from '@snowluma/proton';
import type { EncodableMediaMsgInfo } from '@snowluma/proto-defs/highway';
import { finalizeMediaMsgInfo } from '@snowluma/protocol/highway/pipeline';
import {
  PTT_WAVEFORM_BINS,
  PTT_WAVEFORM_SILENCE,
  amplitudesFromPcmS16le,
  decodePttWaveform,
  encodePttWaveform,
  mergePttWaveform,
  pcmS16leFromWav,
} from '@snowluma/protocol/highway/ptt-waveform';

function le16(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff];
}

function le32(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff];
}

function ascii(text: string): number[] {
  return [...text].map((ch) => ch.charCodeAt(0));
}

function s16leBytes(samples: number[]): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  for (let i = 0; i < samples.length; i += 1) {
    const v = samples[i]! < 0 ? samples[i]! + 0x10000 : samples[i]!;
    out[i * 2] = v & 0xff;
    out[i * 2 + 1] = (v >> 8) & 0xff;
  }
  return out;
}

/** Minimal PCM WAV: 16-bit, little-endian, one data chunk. */
function wavBytes(samples: number[], channels = 1, sampleRate = 24_000): Uint8Array {
  const pcm = s16leBytes(samples);
  const fmtSize = 16;
  const dataSize = pcm.length;
  const riffSize = 4 + (8 + fmtSize) + (8 + dataSize);
  const out = new Uint8Array(12 + 8 + fmtSize + 8 + dataSize);
  let off = 0;
  const put = (bytes: number[]) => {
    out.set(bytes, off);
    off += bytes.length;
  };
  put(ascii('RIFF'));
  put(le32(riffSize));
  put(ascii('WAVE'));
  put(ascii('fmt '));
  put(le32(fmtSize));
  put(le16(1));
  put(le16(channels));
  put(le32(sampleRate));
  put(le32(sampleRate * channels * 2));
  put(le16(channels * 2));
  put(le16(16));
  put(ascii('data'));
  put(le32(dataSize));
  out.set(pcm, off);
  return out;
}

describe('pcmS16leFromWav', () => {
  it('reads s16le PCM and channel count from a plain WAV', () => {
    const wav = wavBytes([0, 32767, -32768], 1, 16_000);
    const parsed = pcmS16leFromWav(wav);
    expect(parsed.channels).toBe(1);
    expect(parsed.sampleRate).toBe(16_000);
    expect(parsed.pcm).toEqual(s16leBytes([0, 32767, -32768]));
  });

  it('rejects a non-PCM WAV', () => {
    const wav = wavBytes([1, 2, 3]);
    wav[20] = 7;
    expect(() => pcmS16leFromWav(wav)).toThrow(/not PCM/);
  });
});

describe('amplitudesFromPcmS16le', () => {
  it('uses the official 30 bars and scales a full-scale peak to 255', () => {
    const loud = new Array(30).fill(0);
    loud[0] = 32767;
    const amps = amplitudesFromPcmS16le(s16leBytes(loud));
    expect(amps.length).toBe(PTT_WAVEFORM_BINS);
    expect(amps[0]).toBe(255);
  });

  it('keeps quiet windows at 0 so the bar has valleys', () => {
    const samples = new Array(60).fill(0);
    samples[0] = 32767;
    const amps = amplitudesFromPcmS16le(s16leBytes(samples), { bins: 2 });
    expect([...amps]).toEqual([255, 0]);
  });

  it('uses the official silence floor when the clip is empty', () => {
    const amps = amplitudesFromPcmS16le(new Uint8Array(0), { bins: 4 });
    expect([...amps]).toEqual(new Array(4).fill(PTT_WAVEFORM_SILENCE));
  });

  it('peaks stereo frames from either channel', () => {
    const pcm = s16leBytes([0, 32767, 0, 0]);
    const amps = amplitudesFromPcmS16le(pcm, { channels: 2, bins: 1 });
    expect(amps[0]).toBe(255);
  });
});

describe('encodePttWaveform / decodePttWaveform', () => {
  it('roundtrips with matching count and amplitudes', () => {
    const amplitudes = new Uint8Array([25, 40, 80, 10]);
    const encoded = encodePttWaveform(amplitudes);
    expect(decodePttWaveform(encoded)).toEqual({ size: 4, amplitudes });
  });

  it('rejects an empty amplitude list', () => {
    expect(() => encodePttWaveform(new Uint8Array(0))).toThrow(/empty/);
  });
});

describe('mergePttWaveform', () => {
  it('writes waveform onto msgInfo so finalize keeps it', () => {
    const waveform = encodePttWaveform(new Uint8Array(PTT_WAVEFORM_BINS).fill(40));
    const upload = { msgInfo: { msgInfoBody: [], extBizInfo: { ptt: { bytesReserve: new Uint8Array([1]) } } } };
    mergePttWaveform(upload, waveform);
    const decoded: any = protobuf_decode<EncodableMediaMsgInfo>(finalizeMediaMsgInfo(upload));
    expect(decoded.extBizInfo.ptt.waveform).toEqual(waveform);
    expect(decoded.extBizInfo.ptt.bytesReserve).toEqual(new Uint8Array([1]));
  });

  it('no-ops when waveform is missing', () => {
    const upload = { msgInfo: { msgInfoBody: [], extBizInfo: {} } };
    mergePttWaveform(upload, undefined);
    expect(upload.msgInfo.extBizInfo).toEqual({});
  });
});
