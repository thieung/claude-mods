/**
 * The weather glyph for a context fill, after Token Weather's scale, with the handoff threshold as the storm line.
 * Calm levels keep the surface's own text color so they read on light and dark themes alike;
 * only the two warning levels take a theme color.
 */
export function forecast(percent: number, threshold: number): { glyph: string; color?: 'warning' | 'error' } {
  if (percent >= threshold) return { glyph: '↯', color: 'error' }
  if (percent >= threshold - 15) return { glyph: '☂', color: 'warning' }
  if (percent >= 25) return { glyph: '☁' }
  return { glyph: '☀' }
}

/** `4.1k`, `820`, `-1.2k`: a signed token count short enough for one band. */
export function shortTokens(n: number): string {
  const sign = n > 0 ? '+' : n < 0 ? '-' : '±'
  const abs = Math.abs(n)
  return `${sign}${abs >= 1000 ? `${(abs / 1000).toFixed(1)}k` : abs}`
}
