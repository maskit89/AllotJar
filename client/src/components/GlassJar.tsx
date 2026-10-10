import { useId } from 'react'
import { hueColor, type CategoryHue } from '../lib/categoryColors'

/** The jar's body outline, in the 64 x 84 drawing box. */
const BODY = 'M8 36 Q8 25 19 24 H45 Q56 25 56 36 V70 Q56 80 46 80 H18 Q8 80 8 70 Z'
/** Where the money's surface sits when the jar is empty (bottom) and full (top). */
const TOP = 30
const BOTTOM = 80

/**
 * A glass jar with a gold screw lid, filled to `pct` with the jar's colour under a soft wave: the
 * Dashboard shelf's drawing of a jar (restyle PR 3). The glass and its highlights follow the
 * theme (--glass, --jar-hl, --jar-hl2 in index.css); the lid is always gold.
 *
 * With `label` the drawing is an image with that name (the jar and how full it is); without
 * one it is decoration and hidden from assistive tech.
 */
export function GlassJar({
  pct,
  hue,
  width = 56,
  label,
  className = '',
}: {
  /** How full, 0 to 100 (clamped). */
  pct: number
  hue: CategoryHue
  width?: number
  label?: string
  className?: string
}) {
  // Gradient and clip ids must be unique on the page: one per jar.
  const id = useId().replace(/:/g, '')
  const colour = hueColor(hue)
  const p = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0))
  const y = (BOTTOM - ((BOTTOM - TOP) * p) / 100).toFixed(1)
  const wave = `M4 ${y} q7.5 -2.6 15 0 t15 0 t15 0 t15 0`
  const height = Math.round((width * 84) / 64)
  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 64 84"
      className={`block shrink-0 overflow-visible ${className}`}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
    >
      <defs>
        <linearGradient id={`gd${id}`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#f6df97" />
          <stop offset=".45" stopColor="#e2b955" />
          <stop offset="1" stopColor="#b9862a" />
        </linearGradient>
        <linearGradient id={`lq${id}`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" style={{ stopColor: colour, stopOpacity: 0.7 }} />
          <stop offset="1" style={{ stopColor: colour }} />
        </linearGradient>
        <linearGradient id={`gl${id}`} x1="0" x2="1">
          <stop offset="0" style={{ stopColor: colour, stopOpacity: 0.16 }} />
          <stop offset=".5" style={{ stopColor: colour, stopOpacity: 0.06 }} />
          <stop offset="1" style={{ stopColor: colour, stopOpacity: 0.14 }} />
        </linearGradient>
        <clipPath id={`cl${id}`}>
          <path d={BODY} />
        </clipPath>
      </defs>
      <ellipse cx="32" cy="81" rx="22" ry="2.2" fill="rgb(0 0 0 / 0.10)" />
      <path d={BODY} style={{ fill: 'var(--glass)' }} />
      <path d={BODY} fill={`url(#gl${id})`} />
      {p > 0 && (
        <g clipPath={`url(#cl${id})`}>
          <path d={`${wave} V84 H4 Z`} fill={`url(#lq${id})`} />
          <path d={wave} fill="none" stroke="rgb(255 255 255 / 0.5)" strokeWidth="1.2" />
        </g>
      )}
      <path d={BODY} fill="none" style={{ stroke: colour }} strokeOpacity=".55" strokeWidth="1.6" />
      <path d="M14 40 Q14 31 20 29" fill="none" style={{ stroke: 'var(--jar-hl)' }} strokeWidth="2.4" strokeLinecap="round" />
      <path d="M14 46 V64" style={{ stroke: 'var(--jar-hl2)' }} strokeWidth="2.4" strokeLinecap="round" />
      <rect x="16" y="17" width="32" height="8" rx="2.5" style={{ fill: 'var(--glass)', stroke: colour }} strokeOpacity=".4" strokeWidth="1.2" />
      <rect x="12" y="4" width="40" height="14" rx="4" fill={`url(#gd${id})`} />
      <rect x="12" y="4" width="40" height="14" rx="4" fill="none" stroke="#a87a22" strokeOpacity=".7" />
      <path d="M18 7v8M23 7v8M28 7v8M33 7v8M38 7v8M43 7v8M48 7v8" stroke="#8c6519" strokeOpacity=".3" strokeWidth="1" />
      <rect x="15" y="5.5" width="34" height="2" rx="1" fill="rgb(255 255 255 / 0.45)" />
    </svg>
  )
}
