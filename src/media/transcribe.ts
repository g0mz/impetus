import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execa } from 'execa';

export type TranscribeResult = { ok: true; text: string; ms: number } | { ok: false; error: string };
/** Transcreve um arquivo de áudio para texto (PT-BR). Plugável: whisper.cpp local hoje. */
export type Transcriber = (audioPath: string) => Promise<TranscribeResult>;

/** Remove marcações do Whisper ([BLANK_AUDIO], (música), [risos]) e espaços sobrando. */
export function cleanTranscript(raw: string): string {
  return raw
    .replace(/\[[^\]]*\]|\((?:m[uú]sica|music|risos|aplausos|sil[eê]ncio|inaud[ií]vel)[^)]*\)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * whisper.cpp (`whisper-cli`) + ffmpeg: OGG/Opus → WAV 16 kHz mono → texto. Sem rede, sem custo por uso.
 * Timeout padrão de 120 s; o arquivo WAV temporário é sempre apagado.
 */
export function createWhisperCppTranscriber(o: {
  whisperBin: string;
  modelPath: string;
  ffmpegBin: string;
  threads?: number;
  timeoutMs?: number;
  language?: string;
}): Transcriber {
  return async (audioPath) => {
    const started = Date.now();
    const wav = path.join(os.tmpdir(), `impetus-${randomUUID()}.wav`);
    try {
      await execa(
        o.ffmpegBin,
        [
          '-nostdin',
          '-loglevel',
          'error',
          '-y',
          '-i',
          audioPath,
          '-ar',
          '16000',
          '-ac',
          '1',
          '-c:a',
          'pcm_s16le',
          wav,
        ],
        {
          timeout: 60_000,
        },
      );
      const r = await execa(
        o.whisperBin,
        [
          '-m',
          o.modelPath,
          '-f',
          wav,
          '-l',
          o.language ?? 'pt',
          '-t',
          String(o.threads ?? Math.max(1, os.cpus().length)),
          '-nt',
          '-np',
        ],
        { timeout: o.timeoutMs ?? 120_000 },
      );
      const text = cleanTranscript(String(r.stdout));
      if (!text) return { ok: false, error: 'áudio sem fala reconhecível' };
      return { ok: true, text, ms: Date.now() - started };
    } catch (e) {
      const err = e as { shortMessage?: string; message: string };
      return { ok: false, error: (err.shortMessage ?? err.message).slice(0, 300) };
    } finally {
      fs.rmSync(wav, { force: true });
    }
  };
}
