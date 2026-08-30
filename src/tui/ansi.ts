/**
 * ANSI エスケープと色の扱い。
 * 端末の色能力を検出して段階的にフォールバックする（SPEC §15.8）。
 */

export type ColorMode = 'truecolor' | 'ansi256' | 'ansi16' | 'none';

export const ESC = '\x1b[';

export const CURSOR_HIDE = `${ESC}?25l`;
export const CURSOR_SHOW = `${ESC}?25h`;
export const ALT_SCREEN_ON = `${ESC}?1049h`;
export const ALT_SCREEN_OFF = `${ESC}?1049l`;
export const CLEAR_SCREEN = `${ESC}2J`;
export const RESET = `${ESC}0m`;

export function moveTo(x: number, y: number): string {
  return `${ESC}${y + 1};${x + 1}H`;
}

export function detectColorMode(
  env: NodeJS.ProcessEnv = process.env,
  isTTY = process.stdout.isTTY === true,
): ColorMode {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return 'none';
  if (env.VO_COLOR_MODE) return env.VO_COLOR_MODE as ColorMode;
  if (!isTTY) return 'none';

  const colorterm = (env.COLORTERM ?? '').toLowerCase();
  if (colorterm.includes('truecolor') || colorterm.includes('24bit')) return 'truecolor';

  const term = (env.TERM ?? '').toLowerCase();
  if (term.includes('256')) return 'ansi256';
  if (term === 'dumb' || term === '') return 'none';
  return 'ansi16';
}

export function rgb(r: number, g: number, b: number): number {
  return (r << 16) | (g << 8) | b;
}

export function unpack(color: number): [number, number, number] {
  return [(color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff];
}

/** 6x6x6 キューブ + グレースケール 24 段への最近傍 */
export function toAnsi256(color: number): number {
  const [r, g, b] = unpack(color);
  if (Math.abs(r - g) < 8 && Math.abs(g - b) < 8) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return 232 + Math.round(((r - 8) / 247) * 23);
  }
  const q = (v: number): number => Math.round((v / 255) * 5);
  return 16 + 36 * q(r) + 6 * q(g) + q(b);
}

const ANSI16_RGB: ReadonlyArray<[number, number, number]> = [
  [0, 0, 0], [128, 0, 0], [0, 128, 0], [128, 128, 0],
  [0, 0, 128], [128, 0, 128], [0, 128, 128], [192, 192, 192],
  [128, 128, 128], [255, 0, 0], [0, 255, 0], [255, 255, 0],
  [0, 0, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255],
];

export function toAnsi16(color: number): number {
  const [r, g, b] = unpack(color);
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < ANSI16_RGB.length; i += 1) {
    const [cr, cg, cb] = ANSI16_RGB[i]!;
    const d = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

/** 前景色の SGR。mode に応じて落とす。 */
export function fgCode(color: number, mode: ColorMode): string {
  if (mode === 'none') return '';
  if (mode === 'truecolor') {
    const [r, g, b] = unpack(color);
    return `${ESC}38;2;${r};${g};${b}m`;
  }
  if (mode === 'ansi256') return `${ESC}38;5;${toAnsi256(color)}m`;
  const i = toAnsi16(color);
  return i < 8 ? `${ESC}${30 + i}m` : `${ESC}${90 + i - 8}m`;
}

export function bgCode(color: number, mode: ColorMode): string {
  if (mode === 'none') return '';
  if (mode === 'truecolor') {
    const [r, g, b] = unpack(color);
    return `${ESC}48;2;${r};${g};${b}m`;
  }
  if (mode === 'ansi256') return `${ESC}48;5;${toAnsi256(color)}m`;
  const i = toAnsi16(color);
  return i < 8 ? `${ESC}${40 + i}m` : `${ESC}${100 + i - 8}m`;
}
