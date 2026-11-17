/**
 * 实时发言人指示
 * ------------------------------------------------------------------
 * 录音过程中用同一套声学线索（基频）做在线轻量聚类，只用于界面提示：
 * - 不落库、不参与最终身份判定；
 * - 编号是“当前这段声音”的临时序号，录音结束后由批量分离重新给出正式编号；
 * - 因此这里叫“发言人 A/B/C”更准确，界面用 S1/S2 着色，不声称是真名。
 */

import { f0Of } from './diarize.js';

const DOWN = 3;            // 48 kHz → 16 kHz
const RING = 4096;         // 85 ms @48 kHz
const MIN_RMS = 0.012;

export class LiveSpeakerTracker {
  constructor({ onChange = null, maxSpeakers = 4 } = {}) {
    this.onChange = onChange;
    this.maxSpeakers = maxSpeakers;
    this.ring = new Uint8Array(RING);
    this.filled = 0;
    this.centers = [];        // log2(F0)
    this.current = null;      // 0-based
    this.candidate = null;
    this.candidateHits = 0;
    this.pendingKey = null;   // 待建档的新音高（连续两次确认才承认）
    this.lastSwitchAt = -1e9;
    this.lastVoiceAt = 0;
    this.samples = 0;
  }

  reset() {
    this.filled = 0;
    this.centers = [];
    this.current = null;
    this.candidate = null;
    this.candidateHits = 0;
    this.pendingKey = null;
    this.lastSwitchAt = -1e9;
    this.lastVoiceAt = 0;
    this.samples = 0;
  }

  /** 每帧喂入 analyser 的时域数据（Uint8Array，128 为静音中心） */
  push(frame) {
    if (!frame?.length) return;
    const n = Math.min(frame.length, RING);
    if (this.filled < RING) {
      const take = Math.min(n, RING - this.filled);
      this.ring.set(frame.subarray(0, take), this.filled);
      this.filled += take;
    } else {
      this.ring.copyWithin(0, n);
      this.ring.set(frame.subarray(0, n), RING - n);
    }
    this.samples += 1;
    if (this.samples % 12 !== 0) return; // 约每 200 ms 分析一次
    this.analyze();
  }

  analyze() {
    if (this.filled < RING * 0.6) return;
    const len = Math.floor(this.filled / DOWN);
    if (len < 1024) return;
    const x = new Float32Array(len);
    let mean = 0;
    for (let i = 0; i < len; i += 1) {
      x[i] = (this.ring[i * DOWN] - 128) / 128;
      mean += x[i];
    }
    mean /= len;
    let energy = 0;
    for (let i = 0; i < len; i += 1) { x[i] -= mean; energy += x[i] * x[i]; }
    const rms = Math.sqrt(energy / len);

    const now = performance.now();
    if (rms < MIN_RMS) {
      if (this.current !== null && now - this.lastVoiceAt > 1200) {
        this.current = null;
        this.onChange?.(null, { reason: 'silence' });
      }
      return;
    }
    this.lastVoiceAt = now;

    const sampleRate = 16000; // 已按 DOWN 降采样
    const { f0, clarity } = f0Of(x, 0, sampleRate);
    this.lastRms = rms;
    if (!f0 || clarity < 0.3 || f0 < 55 || f0 > 400) return;
    this.lastF0 = f0;
    const key = Math.log2(f0);

    let idx = -1;
    let bestD = Infinity;
    this.centers.forEach((c, i) => {
      const d = Math.abs(c - key);
      if (d < bestD) { bestD = d; idx = i; }
    });
    if (idx >= 0 && bestD <= 0.3) {
      this.centers[idx] = this.centers[idx] * 0.82 + key * 0.18;
    } else if (this.pendingKey !== null && Math.abs(this.pendingKey - key) < 0.14) {
      // 新音高连续两次接近才建档：起始那半窗静音很容易给出一个假基频，
      // 若直接建档，恒定音调也会被标成 S2（先假 S1 再真 S2）。
      this.pendingKey = null;
      if (this.centers.length < this.maxSpeakers) {
        this.centers.push(key);
        idx = this.centers.length - 1;
      } else {
        idx = this.current ?? 0;
      }
    } else {
      this.pendingKey = key;
      if (this.current === null) return; // 第一位发言人也要等确认，避免噪声抢先
      if (idx < 0) return;
      idx = this.current;
    }

    if (idx === this.current) { this.candidateHits = 0; return; }
    if (idx === this.candidate) this.candidateHits += 1;
    else { this.candidate = idx; this.candidateHits = 1; }
    // 需要连续两次判断一致、且距离上次切换超过 500 ms，避免来回跳
    if (this.candidateHits >= 2 && now - this.lastSwitchAt > 500) {
      this.current = idx;
      this.lastSwitchAt = now;
      this.candidateHits = 0;
      this.onChange?.(idx, { f0: Math.round(f0), rms });
    }
  }
}
