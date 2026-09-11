import fs from 'node:fs';
import path from 'node:path';

/**
 * 通話の録音。動作確認・デモ提示用の機能で、既定では無効。
 *
 * 出力は 8kHz 16bit ステレオの WAV:
 *   左チャンネル = 発信者の声（Twilio の inbound トラック）
 *   右チャンネル = AI の声（こちらが Twilio へ送出した音声）
 *
 * 左右を分けているのは、どちらが話しているか・応答までの間・割り込みの挙動を
 * 聞いて判断できるようにするため。μ-law のまま WAV に入れることもできるが、
 * 再生環境を選ぶため PCM16 に展開して保存する。
 *
 * **音声は電話回線を通ったそのもの（8kHz 狭帯域）** なので、
 * 住人が実際に耳にする音質がそのまま記録される。
 */

/** μ-law 8kHz mono は 1ミリ秒あたり 8 サンプル。 */
const SAMPLES_PER_MS = 8;
const SAMPLE_RATE = 8000;

/** G.711 μ-law → PCM16 の展開表（256通りしかないので事前計算する）。 */
const MULAW_TABLE = (() => {
  const table = new Int16Array(256);
  for (let i = 0; i < 256; i += 1) {
    const u = ~i & 0xff;
    const sign = u & 0x80;
    const exponent = (u >> 4) & 0x07;
    const mantissa = u & 0x0f;
    let sample = ((mantissa << 3) + 0x84) << exponent;
    sample -= 0x84;
    table[i] = sign ? -sample : sample;
  }
  return table;
})();

/** 必要に応じて伸びる Int16 バッファ。 */
class SampleBuffer {
  private data = new Int16Array(SAMPLE_RATE * 60); // まず60秒ぶん
  private end = 0;

  get length(): number {
    return this.end;
  }

  private ensure(size: number): void {
    if (size <= this.data.length) return;
    let next = this.data.length;
    while (next < size) next *= 2;
    const grown = new Int16Array(next);
    grown.set(this.data.subarray(0, this.end));
    this.data = grown;
  }

  /** 指定サンプル位置へ書き込む。空いた部分は無音（0）のまま。 */
  writeAt(position: number, samples: Int16Array): void {
    const needed = position + samples.length;
    this.ensure(needed);
    this.data.set(samples, position);
    if (needed > this.end) this.end = needed;
  }

  /** 指定位置より後ろを捨てる（barge-in で再生されなかった分の切り詰め）。 */
  truncateTo(position: number): void {
    if (position >= this.end) return;
    this.data.fill(0, Math.max(0, position), this.end);
    this.end = Math.max(0, position);
  }

  subarray(length: number): Int16Array {
    return this.data.subarray(0, length);
  }
}

function decodeMuLaw(payloadBase64: string): Int16Array {
  const bytes = Buffer.from(payloadBase64, 'base64');
  const out = new Int16Array(bytes.length);
  for (let i = 0; i < bytes.length; i += 1) out[i] = MULAW_TABLE[bytes[i] as number] as number;
  return out;
}

export class CallRecorder {
  private readonly caller = new SampleBuffer();
  private readonly ai = new SampleBuffer();

  /** AI 側の次の書き込み位置（サンプル単位）。発話は連続して書く。 */
  private aiWriteHead = 0;
  /** 現在再生中の AI 発話の開始位置。barge-in の切り詰めに使う。 */
  private aiItemStart: number | null = null;

  private frames = 0;
  private deltas = 0;

  /**
   * 発信者の音声。Twilio の timestamp（ストリーム開始からのミリ秒）を
   * そのまま位置に使うため、フレーム欠落があっても時間軸がずれない。
   */
  writeCaller(payloadBase64: string, timestampMs: number): void {
    this.caller.writeAt(timestampMs * SAMPLES_PER_MS, decodeMuLaw(payloadBase64));
    this.frames += 1;
  }

  /** AI の新しい発話の開始。発信者側の時間軸に合わせて位置を決める。 */
  startAiItem(atTimestampMs: number): void {
    this.aiWriteHead = atTimestampMs * SAMPLES_PER_MS;
    this.aiItemStart = this.aiWriteHead;
  }

  writeAi(payloadBase64: string): void {
    const samples = decodeMuLaw(payloadBase64);
    this.ai.writeAt(this.aiWriteHead, samples);
    this.aiWriteHead += samples.length;
    this.deltas += 1;
  }

  /**
   * barge-in で発信者に届かなかった分を録音から取り除く。
   *
   * これをしないと、Twilio の再生バッファごと破棄されて**実際には
   * 聞こえていない音声**が録音に残り、通話の再現にならない。
   * audioEndMs は barge-in 時に算出済みの「実際に聞こえた長さ」。
   */
  truncateAiTo(audioEndMs: number): void {
    if (this.aiItemStart === null) return;
    this.ai.truncateTo(this.aiItemStart + audioEndMs * SAMPLES_PER_MS);
    this.aiWriteHead = Math.min(this.aiWriteHead, this.aiItemStart + audioEndMs * SAMPLES_PER_MS);
    this.aiItemStart = null;
  }

  get isEmpty(): boolean {
    return this.caller.length === 0 && this.ai.length === 0;
  }

  /** WAV を書き出し、保存先のパスを返す。 */
  save(dir: string, fileName: string): string {
    const total = Math.max(this.caller.length, this.ai.length);
    const left = this.caller.subarray(total);
    const right = this.ai.subarray(total);

    // インターリーブ（L,R,L,R,...）
    const interleaved = Buffer.alloc(total * 2 * 2);
    for (let i = 0; i < total; i += 1) {
      interleaved.writeInt16LE(left[i] ?? 0, i * 4);
      interleaved.writeInt16LE(right[i] ?? 0, i * 4 + 2);
    }

    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + interleaved.length, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16); // fmt チャンクのサイズ
    header.writeUInt16LE(1, 20); // PCM
    header.writeUInt16LE(2, 22); // ステレオ
    header.writeUInt32LE(SAMPLE_RATE, 24);
    header.writeUInt32LE(SAMPLE_RATE * 2 * 2, 28); // バイト/秒
    header.writeUInt16LE(4, 32); // ブロックサイズ
    header.writeUInt16LE(16, 34); // ビット深度
    header.write('data', 36);
    header.writeUInt32LE(interleaved.length, 40);

    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, fileName);
    fs.writeFileSync(filePath, Buffer.concat([header, interleaved]));
    return filePath;
  }

  get stats(): { frames: number; deltas: number; durationMs: number } {
    return {
      frames: this.frames,
      deltas: this.deltas,
      durationMs: Math.round(Math.max(this.caller.length, this.ai.length) / SAMPLES_PER_MS),
    };
  }
}
