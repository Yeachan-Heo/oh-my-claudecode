/**
 * @file Shared timing utilities — Gaussian random delays for human-like behavior.
 *
 * Extracted from login.ts and poster.ts to eliminate duplication.
 */

/**
 * Box-Muller 가우스 분포 기반 랜덤 정수 생성.
 * 결과는 [min, max] 범위로 클램핑된다.
 */
export function gaussRandom(min: number, max: number): number {
  const mean = (min + max) / 2;
  const stddev = (max - min) / 6;
  let u: number, v: number, s: number;
  do { u = Math.random() * 2 - 1; v = Math.random() * 2 - 1; s = u * u + v * v; }
  while (s >= 1 || s === 0);
  const mul = Math.sqrt(-2 * Math.log(s) / s);
  return Math.round(Math.max(min, Math.min(max, mean + stddev * u * mul)));
}

/**
 * 가우스 분포 기반 지연값 계산 — mean/stddev 직접 지정.
 * 음수는 0으로 클램핑된다.
 */
export function gaussianDelay(mean: number, stddev: number): number {
  let u: number, v: number, s: number;
  do { u = Math.random() * 2 - 1; v = Math.random() * 2 - 1; s = u * u + v * v; }
  while (s >= 1 || s === 0);
  const mul = Math.sqrt(-2 * Math.log(s) / s);
  return Math.max(0, Math.round(mean + stddev * u * mul));
}

/**
 * 가우스 분포 기반 지연 후 실제 sleep.
 * 반환값: 실제 대기한 밀리초.
 */
export async function humanDelay(min: number, max: number): Promise<number> {
  const ms = gaussRandom(min, max);
  await new Promise(r => setTimeout(r, ms));
  return ms;
}
