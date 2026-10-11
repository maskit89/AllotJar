/**
 * The Dashboard's cards (restyle PR 3): the shared card surface (as `ui/Card`) with the mock-ups'
 * padding, 22px 24px from 700px wide and 18px on a phone, and a 16px radius (14px on a phone).
 */
export const DASH_CARD =
  'min-w-0 rounded-[14px] border border-slate-200/70 bg-surface p-[18px] shadow-card min-[700px]:rounded-2xl min-[700px]:px-6 min-[700px]:py-[22px]'

/** A card's title (SPEC: 16px, 650). */
export const CARD_TITLE = 'text-base font-[650] tracking-[-0.01em] text-slate-900'

/** The (i) beside a card title, as on the Dashboard's cards: a 22px target, the icon at 15px. */
export const TITLE_HINT =
  "relative -my-1 inline-grid size-[22px] place-items-center rounded-full text-slate-500 opacity-85 transition after:absolute after:-inset-[9px] after:content-[''] hover:bg-slate-500/10 hover:opacity-100"
