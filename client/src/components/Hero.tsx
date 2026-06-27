import type { ReactNode } from 'react'

/** One dark-glass stat tile on the right of the hero. */
export interface HeroTile {
  label: ReactNode
  value: ReactNode
}

/**
 * The unified gradient hero every screen opens with, so the app reads as one
 * product: a dark-green band carrying an uppercase eyebrow, the single big
 * **gold** number for the screen, an optional footnote (the Budget "every euro
 * has a job" check), and up to two dark-glass stat tiles on the right.
 *
 * The number is real text styled with `.gold-number` (the metallic clip
 * gradient) — screen readers still read it, so `amountLabel` is only needed when
 * the visible glyphs alone aren't a good accessible name (e.g. a leading symbol).
 * All five heroes render at the same 172px height.
 */
export function Hero({
  eyebrow,
  amount,
  amountLabel,
  tiles = [],
  footnote,
}: {
  eyebrow: ReactNode
  amount: ReactNode
  amountLabel?: string
  tiles?: HeroTile[]
  footnote?: ReactNode
}) {
  return (
    <section
      className="hero-surface grid min-h-[172px] items-center gap-6 rounded-[20px] px-[30px] py-[26px] [grid-template-columns:repeat(auto-fit,minmax(240px,1fr))]"
    >
      <div>
        <p className="text-[12px] font-semibold uppercase tracking-[0.08em] text-white/85">{eyebrow}</p>
        <p
          className="gold-number mt-2 w-fit text-[44px] font-extrabold leading-none tracking-[-0.02em]"
          aria-label={amountLabel}
        >
          {amount}
        </p>
        {footnote && <div className="mt-[18px]">{footnote}</div>}
      </div>

      {tiles.length > 0 && (
        <div className="flex flex-col gap-2.5">
          {tiles.map((t, i) => (
            <div
              key={i}
              className="flex items-center justify-between rounded-[13px] bg-black/20 px-4 py-3"
            >
              <span className="text-[13px] text-white/90">{t.label}</span>
              <span className="text-base font-bold tabular-nums">{t.value}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

/**
 * The Budget hero's gold "every euro has a job" badge — a filled gold disc with a
 * dark CSS checkmark, beside the label. Shown only when the budget is balanced.
 */
export function EveryEuroBadge({ children = 'Every euro has a job' }: { children?: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2.5 rounded-full bg-black/[0.18] px-[15px] py-2 text-[13.5px] font-semibold">
      <span className="relative h-[17px] w-[17px] shrink-0 rounded-full bg-gold" aria-hidden>
        <span className="absolute left-[5px] top-[3px] h-2 w-1 rotate-[43deg] border-[#1c1407] [border-width:0_2px_2px_0]" />
      </span>
      {children}
    </span>
  )
}
