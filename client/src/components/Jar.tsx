import { hueColor, hueTint, type CategoryHue } from '../lib/categoryColors'

/**
 * The AllotJar brand mark — the theme-aware coin-jar SVG from brand/README §6:
 * a green jar body (`--accent`) with a gold lid + coin fill (`--gold`), so it
 * follows light/dark automatically. One shared body path (viewBox 0 0 64 84) at
 * three sizes — compact (mobile top bar), default (sidebar), lg (auth). Decorative;
 * the adjacent "AllotJar" wordmark carries the name.
 */
export function JarLogo({ compact = false, lg = false }: { compact?: boolean; lg?: boolean }) {
  const { w, h } = lg ? { w: 52, h: 68 } : compact ? { w: 26, h: 34 } : { w: 30, h: 39 }
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

/**
 * A sinking-fund "jar" — the redesign's signature metaphor. A brass **gold lid**
 * sits on a rounded **body** outlined in the category hue and tinted with it; an
 * inner fill rises from the bottom to `pct` of the goal, with the percent centred
 * near the top in `--ink`. Two sizes: the Budget jars shelf (`shelf`) and the
 * Funds cards (`card`).
 *
 * The colour rides graphics only (lid / outline / fill), so it needs just 3:1.
 * Decorative by default; pass `label` to expose it to assistive tech as an image
 * when the surrounding text doesn't already convey the percentage.
 */
export function Jar({
  hue,
  pct,
  size = 'shelf',
  label,
  showPct = true,
}: {
  hue: CategoryHue
  /** 0–100; clamped. */
  pct: number
  size?: 'shelf' | 'card'
  label?: string
  /** Render the percentage inside the jar. Off on the Funds cards, where a pill carries it. */
  showPct?: boolean
}) {
  const clamped = Math.max(0, Math.min(100, Math.round(pct)))
  const color = hueColor(hue)
  const tint = hueTint(hue)
  const m =
    size === 'shelf'
      ? { w: 72, h: 100, lidTop: -5, lidLeft: 14, lidW: 44, lidH: 10, lidR: 4, bodyTop: 6, pctTop: 8, pctSize: 12.5 }
      : { w: 58, h: 82, lidTop: -4, lidLeft: 11, lidW: 36, lidH: 9, lidR: 3, bodyTop: 5, pctTop: 6, pctSize: 11 }

  return (
    <div
      className="relative shrink-0"
      style={{ width: m.w, height: m.h }}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {/* Brass lid. */}
      <div
        className="absolute rounded-[4px]"
        style={{
          top: m.lidTop,
          left: m.lidLeft,
          width: m.lidW,
          height: m.lidH,
          borderRadius: m.lidR,
          background: 'linear-gradient(180deg, rgba(255,255,255,.4), rgba(0,0,0,.08)), var(--color-gold)',
          boxShadow: '0 1px 2px rgba(0,0,0,.12)',
        }}
      />
      {/* Body: hue outline + tint fill, with the rising inner fill clipped inside. */}
      <div
        className="absolute inset-x-0 bottom-0 overflow-hidden"
        style={{
          top: m.bodyTop,
          border: `2.5px solid ${color}`,
          borderRadius: '6px 6px 16px 16px',
          background: tint,
        }}
      >
        <div className="absolute inset-x-0 bottom-0" style={{ height: `${clamped}%`, background: color }} />
        {showPct && (
          <div
            className="absolute inset-x-0 text-center font-bold text-slate-900"
            style={{ top: m.pctTop, fontSize: m.pctSize }}
          >
            {clamped}%
          </div>
        )}
      </div>
    </div>
  )
}
