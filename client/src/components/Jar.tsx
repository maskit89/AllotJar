/**
 * The AllotJar brand mark — the theme-aware coin-jar SVG from brand/README §6:
 * a green jar body (`--accent`) with a gold lid + coin fill (`--gold`), so it
 * follows light/dark automatically. One shared body path (viewBox 0 0 64 84) at
 * three sizes — compact, default and lg (auth), or any height in px via `size` (the app
 * frame's sidebar and phone top bar). Decorative;
 * the adjacent "AllotJar" wordmark carries the name.
 */
export function JarLogo({ compact = false, lg = false, size }: { compact?: boolean; lg?: boolean; size?: number }) {
  const { w, h } = size
    ? { w: Math.round((size * 64) / 84), h: size }
    : lg
      ? { w: 52, h: 68 }
      : compact
        ? { w: 26, h: 34 }
        : { w: 30, h: 39 }
  return (
    <svg width={w} height={h} viewBox="0 0 64 84" fill="none" className="shrink-0" aria-hidden>
      <path
        d="M17 19L17 25C17 30 9 31 9 39L9 66A13 13 0 0 0 22 79L42 79A13 13 0 0 0 55 66L55 39C55 31 47 30 47 25L47 19Z"
        fill="var(--accent)"
      />
      <path d="M9 48Q32 45 55 48L55 66A13 13 0 0 1 42 79L22 79A13 13 0 0 1 9 66Z" fill="var(--gold)" />
      <rect x="13" y="14.5" width="38" height="5" rx="2.5" fill="var(--gold)" />
      <rect x="15" y="3.5" width="34" height="12.5" rx="3.5" fill="var(--gold)" />
      <rect x="16.5" y="4.8" width="31" height="2.6" rx="1.3" fill="#ffffff" opacity=".28" />
    </svg>
  )
}
