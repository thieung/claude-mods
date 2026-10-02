/** The weather word for a context fill, after Token Weather's scale, with the handoff threshold as the storm line. */
export function forecast(percent: number, threshold: number): { glyph: string; color: string } {
  if (percent >= threshold) return { glyph: '↯', color: 'red' }
  if (percent >= threshold - 15) return { glyph: '☂', color: 'yellow' }
  if (percent >= 25) return { glyph: '☁', color: 'white' }
  return { glyph: '☀', color: 'green' }
}

/** `4.1k`, `820`, `-1.2k`: a signed token count short enough for one band. */
export function shortTokens(n: number): string {
  const sign = n > 0 ? '+' : n < 0 ? '-' : '±'
  const abs = Math.abs(n)
  return `${sign}${abs >= 1000 ? `${(abs / 1000).toFixed(1)}k` : abs}`
}
