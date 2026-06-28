import { hueColor, hueTint, type CategoryHue } from '../lib/categoryColors'

/**
 * The AllotJar brand mark — a miniature brass-lidded jar, partly filled with the
 * brand green. Two sizes: the desktop sidebar (default) and the compact mobile
 * top bar. Decorative; the adjacent "AllotJar" wordmark carries the name.
 */
export function JarLogo({ compact = false, lg = false }: { compact?: boolean; lg?: boolean }) {
  const s = lg
    ? { w: 52, h: 56, lidL: 14, lidW: 24, lidH: 8, lidR: 4, bodyTop: 10, bodyR: 14 }
    : compact
      ? { w: 26, h: 28, lidL: 7, lidW: 12, lidH: 4, lidR: 2, bodyTop: 5, bodyR: 7 }
      : { w: 30, h: 32, lidL: 8, lidW: 14, lidH: 5, lidR: 3, bodyTop: 6, bodyR: 8 }
  return (
    <div className="relative shrink-0" style={{ width: s.w, height: s.h }} aria-hidden>
      <div
        className="absolute top-0"
        style={{
          left: s.lidL,
          width: s.lidW,
          height: s.lidH,
          borderRadius: s.lidR,
          background: 'linear-gradient(180deg, rgba(255,255,255,.4), rgba(0,0,0,.08)), var(--color-gold)',
        }}
      />
      <div
        className="absolute bottom-0 bg-brand-600/15"
        style={{ left: 3, right: 3, top: s.bodyTop, borderRadius: s.bodyR }}
      />
      <div
        className="absolute bottom-0 h-[60%] bg-brand-600"
        style={{ left: 3, right: 3, borderRadius: `1px 1px ${s.bodyR}px ${s.bodyR}px` }}
      />
    </div>
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
