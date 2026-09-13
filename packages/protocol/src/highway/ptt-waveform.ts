import type { PttWaveform } from '@snowluma/proto-defs/element';
import type { NTV2UploadRespBody } from '@snowluma/proto-defs/highway';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';

/** Official receive-side default bar count (`ParsePttWave` fallback). */
export const PTT_WAVEFORM_BINS = 30;
/** Official default amplitude floor when a bin (or the whole clip) is silent. */
export const PTT_WAVEFORM_SILENCE = 25;

function u16le(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function u32le(bytes: Uint8Array, offset: number): number {
  return bytes[offset]!
    | (bytes[offset + 1]! << 8)
    | (bytes[offset + 2]! << 16)
    | (bytes[offset + 3]! << 24);
}

function fourcc(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset]!,
    bytes[offset + 1]!,
    bytes[offset + 2]!,
    bytes[offset + 3]!,
  );
}

function s16le(bytes: Uint8Array, offset: number): number {
  const raw = u16le(bytes, offset);
  return raw >= 0x8000 ? raw - 0x10000 : raw;
}

/**
 * Pull s16le PCM out of a WAV produced by `decodeAudioToFmt(..., 'wav')`.
 * Rejects non-PCM / non-16-bit so a botched transcode cannot invent bars.
 */
export function pcmS16leFromWav(wav: Uint8Array): {
  pcm: Uint8Array;
  channels: number;
  sampleRate: number;
} {
  if (wav.length < 12) throw new Error('wav is truncated');
  if (fourcc(wav, 0) !== 'RIFF' || fourcc(wav, 8) !== 'WAVE') {
    throw new Error('wav is not a RIFF/WAVE file');
  }

  let offset = 12;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let audioFormat = 0;
  let data: Uint8Array | undefined;

  while (offset + 8 <= wav.length) {
    const id = fourcc(wav, offset);
    const size = u32le(wav, offset + 4);
    const start = offset + 8;
    if (start + size > wav.length) throw new Error('wav chunk is truncated');
    if (id === 'fmt ') {
      if (size < 16) throw new Error('wav fmt chunk is short');
      audioFormat = u16le(wav, start);
      channels = u16le(wav, start + 2);
      sampleRate = u32le(wav, start + 4);
      bitsPerSample = u16le(wav, start + 14);
    } else if (id === 'data') {
      data = wav.subarray(start, start + size);
    }
    offset = start + size + (size & 1);
  }

  if (!data) throw new Error('wav has no data chunk');
  if (audioFormat !== 1) throw new Error(`wav format ${audioFormat} is not PCM`);
  if (channels < 1) throw new Error('wav channel count is invalid');
  if (bitsPerSample !== 16) throw new Error(`wav bits ${bitsPerSample} is not s16`);
  return { pcm: data, channels, sampleRate };
}

function silentWaveform(bins: number): Uint8Array {
  return new Uint8Array(bins).fill(PTT_WAVEFORM_SILENCE);
}

/**
 * Peak each window of interleaved s16le frames into official-length bars.
 * Quiet windows stay 0 (valleys). A fully silent clip uses the official floor
 * so private-chat clients still draw a progress track.
 */
export function amplitudesFromPcmS16le(
  pcm: Uint8Array,
  options: { channels?: number; bins?: number } = {},
): Uint8Array {
  const channels = options.channels ?? 1;
  const bins = options.bins ?? PTT_WAVEFORM_BINS;
  if (channels < 1 || bins < 1) throw new Error('waveform channels/bins must be >= 1');

  const frameSize = channels * 2;
  const frames = Math.floor(pcm.length / frameSize);
  if (frames === 0) return silentWaveform(bins);

  const out = new Uint8Array(bins);
  let any = false;
  for (let bin = 0; bin < bins; bin += 1) {
    const start = Math.floor((bin * frames) / bins);
    let end = Math.floor(((bin + 1) * frames) / bins);
    if (end <= start) end = start + 1;
    let peak = 0;
    for (let frame = start; frame < end && frame < frames; frame += 1) {
      const base = frame * frameSize;
      for (let channel = 0; channel < channels; channel += 1) {
        const sample = Math.abs(s16le(pcm, base + channel * 2));
        if (sample > peak) peak = sample;
      }
    }
    const amplitude = Math.min(255, Math.round((peak * 255) / 32767));
    if (amplitude > 0) any = true;
    out[bin] = amplitude;
  }
  return any ? out : silentWaveform(bins);
}

/** Encode amplitudes as the blob `ParsePttWave` accepts (count == bytes). */
export function encodePttWaveform(amplitudes: Uint8Array): Uint8Array {
  if (amplitudes.length === 0) throw new Error('ptt waveform amplitudes are empty');
  return protobuf_encode<PttWaveform>({
    size: amplitudes.length,
    amplitudes,
  });
}

export function decodePttWaveform(bytes: Uint8Array): { size: number; amplitudes: Uint8Array } {
  const decoded = protobuf_decode<PttWaveform>(bytes);
  const amplitudes = decoded.amplitudes ?? new Uint8Array(0);
  const size = decoded.size ?? 0;
  if (size !== amplitudes.length) {
    throw new Error(`ptt waveform count ${size} != amplitudes ${amplitudes.length}`);
  }
  return { size, amplitudes };
}

/** Stamp computed waveform onto the upload response so finalize cannot drop it. */
export function mergePttWaveform(
  upload: NTV2UploadRespBody,
  waveform: Uint8Array | undefined,
): void {
  if (!waveform || waveform.length === 0 || !upload.msgInfo) return;
  const ext = upload.msgInfo.extBizInfo ?? {};
  upload.msgInfo.extBizInfo = {
    ...ext,
    ptt: { ...ext.ptt, waveform },
  };
}
