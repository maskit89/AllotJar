import { useEffect, useRef, type ReactNode } from 'react'
import { useDialogA11y } from '../onboarding/useDialogA11y'
import { CloseIcon } from './icons'
import { InfoHint } from './InfoHint'
import { useMediaQuery } from '../lib/useMediaQuery'

const noop = () => {}

/**
 * An accessible modal dialog: a labelled `role="dialog" aria-modal` card centred
 * over a dimmed backdrop, closing on backdrop click, the ✕, or Escape, with a
 * focus trap + autofocus + focus restore (via useDialogA11y). Mount it
 * conditionally — `{open && <Modal …/>}` — so the trap engages on open. Used by
 * the redesign's add/invite flows (Add transaction, Add account, New jar, Invite).
 *
 * `sheet` (opt-in, the Allocation page's dialogs, restyle PR 10): the polished mock-ups' dialog
 * frame instead. On a wide screen a 480px card, as tall as the screen allows (24px clear of each
 * edge); on a phone (below 700px) a bottom sheet with a grab handle that closes it, in place of
 * the ✕. Either way the title and `footer` stay put and only the middle scrolls, with a soft
 * shadow at an edge that has more to show, so a long dialog fits a 375x667 phone. `hint` adds an
 * (i) after the title (the dialog keeps the title as its name). Focus opens on the visible close
 * control (the ✕, or the grab handle on a phone), as the plain dialog's does. Left out, the dialog
 * is unchanged.
 *
 * `dismissible={false}` (sheet only; the blocking consent and password prompts, restyle PR 17):
 * nothing closes it — no ✕ or grab handle, no scrim click, no Escape — so the only ways out are the
 * footer's own actions. Focus then opens on the footer control marked `data-sheet-focus` (its
 * primary), as there is no close control to land on. `zIndex` (opt-in) raises it over other fixed
 * layers (the analytics banner, the onboarding dialogs). Left out, both are as before.
 *
 * `banner` (sheet only, opt-in; the onboarding welcome, restyle PR 19): decoration drawn above the
 * title row (under the phone's grab handle), such as the green room with its jars. `describedBy`
 * (opt-in) points the dialog's `aria-describedby` at an element inside it, so a screen reader reads
 * that line with the title. Left out, the dialog is as before.
 */
export function Modal({
  title,
  onClose,
  children,
  size = 'md',
  sheet = false,
  hint,
  hintLabel,
  footer,
  dismissible = true,
  zIndex,
  banner,
  describedBy,
}: {
  title: ReactNode
  onClose: () => void
  children: ReactNode
  size?: 'md' | 'lg'
  /** The mock-ups' frame: a centred card on a wide screen, a bottom sheet on a phone (see above). */
  sheet?: boolean
  /** Sheet only: an (i) after the title, holding what the dialog does. */
  hint?: ReactNode
  /** The (i)'s accessible name (defaults to "About this dialog"). */
  hintLabel?: string
  /** Sheet only: what stays at the foot of the sheet while the middle scrolls (the actions). */
  footer?: ReactNode
  /** Sheet only: `false` removes every way to close it (see above); the footer's actions are the exits. */
  dismissible?: boolean
  /** Sheet only: the layer it sits on (the default is 50). */
  zIndex?: number
  /** Sheet only: decoration above the title row (see above). */
  banner?: ReactNode
  /** The id of the element that describes the dialog (its `aria-describedby`). */
  describedBy?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  // A sheet that cannot be dismissed ignores Escape too.
  useDialogA11y(ref, sheet && !dismissible ? noop : onClose)
  // Sheet: a phone closes it by the grab handle, a wide screen by the ✕ (one of the two at a time).
  const phone = useMediaQuery('(max-width: 699.98px)')

  // Lock background scroll while the dialog is open.
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [])

  // Sheet: focus opens on the close control (useDialogA11y has focused the first focusable, which
  // on a wide screen is the title's (i): its hint would open each time). Runs after useDialogA11y's
  // own effect, so focus still returns to the opener on close.
  useEffect(() => {
    if (sheet) ref.current?.querySelector<HTMLElement>('[data-sheet-close], [data-sheet-focus]')?.focus()
  }, [sheet])

  const label = typeof title === 'string' ? title : undefined

  if (sheet) {
    return (
      // One column that may shrink below its content (minmax(0,1fr)), and a card that may too
      // (min-w-0): a long line inside truncates or wraps instead of widening the sheet past the screen.
      <div
        className="fixed inset-0 z-50 grid grid-cols-[minmax(0,1fr)] place-items-center p-6 max-[699.98px]:items-end max-[699.98px]:justify-items-stretch max-[699.98px]:p-0"
        style={zIndex === undefined ? undefined : { zIndex }}
      >
        <div
          className="fixed inset-0 bg-[rgb(10_20_15/0.26)] backdrop-blur-[2px] backdrop-saturate-[0.9] dark:bg-black/50"
          aria-hidden
          onClick={dismissible ? onClose : undefined}
        />
        <div
          ref={ref}
          role="dialog"
          aria-modal="true"
          aria-label={label}
          aria-describedby={describedBy}
          className="sheet-dlg relative z-10 flex max-h-[calc(100dvh-48px)] w-full max-w-[480px] min-w-0 flex-col rounded-2xl text-sm border border-slate-200/80 px-6 pt-[22px] pb-6 shadow-[var(--shadow-frame-lg)] max-[699.98px]:max-h-[calc(100dvh-12px)] max-[699.98px]:max-w-none max-[699.98px]:rounded-t-[20px] max-[699.98px]:rounded-b-none max-[699.98px]:border-x-0 max-[699.98px]:border-b-0 max-[699.98px]:px-[18px] max-[699.98px]:pt-2 max-[699.98px]:pb-[calc(20px+env(safe-area-inset-bottom))]"
        >
          {/* The phone's grab handle: a real button (as the action sheets' handle), the sheet's close there. */}
          {phone && dismissible && (
            <button
              type="button"
              data-sheet-close=""
              onClick={onClose}
              aria-label="Close"
              // The bar is the action sheets' handle; its target is 78x41 (it reaches a little onto the scrim, which closes too).
              className="relative mx-auto mb-3.5 block h-[5px] w-[38px] flex-none rounded-full bg-slate-500/35 after:absolute after:-inset-x-5 after:-inset-y-[18px] after:content-['']"
            />
          )}
          {banner && <div className="flex-none">{banner}</div>}
          <div className="mb-4 flex flex-none items-center gap-3 max-[699.98px]:mb-3.5">
            <div className="flex min-w-0 items-center gap-1.5">
              <h2 className="text-lg leading-tight font-bold tracking-[-0.018em] text-slate-900">{title}</h2>
              {hint && (
                <InfoHint
                  fixed
                  label={hintLabel ?? 'About this dialog'}
                  buttonClassName="relative -my-1 inline-grid size-[22px] shrink-0 place-items-center rounded-full text-slate-500 opacity-85 transition after:absolute after:-inset-[9px] after:content-[''] hover:bg-slate-500/10 hover:opacity-100"
                >
                  {hint}
                </InfoHint>
              )}
            </div>
            {!phone && dismissible && (
              <button
                type="button"
                data-sheet-close=""
                onClick={onClose}
                aria-label="Close"
                className="-my-2 -mr-2.5 ml-auto grid size-8 flex-none place-items-center rounded-lg text-slate-500 transition hover:bg-surface-2 hover:text-slate-900 dark:hover:bg-foreground/7"
              >
                <CloseIcon className="h-5 w-5" />
              </button>
            )}
          </div>
          <div className="sheet-dlg-body -mx-6 min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 pt-0.5 pb-1 max-[699.98px]:-mx-[18px] max-[699.98px]:px-[18px]">
            {children}
          </div>
          {footer && <div className="flex-none">{footer}</div>}
        </div>
      </div>
    )
  }

  const width = size === 'lg' ? 'max-w-2xl' : 'max-w-md'

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:items-center">
      <div className="fixed inset-0 bg-black/40" aria-hidden onClick={onClose} />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        aria-describedby={describedBy}
        className={`relative z-10 my-auto w-full ${width} rounded-2xl border border-slate-200 bg-surface p-5 shadow-card`}
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-base font-bold tracking-[-0.01em] text-slate-900">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-8 w-8 items-center justify-center rounded-full text-slate-500 transition hover:bg-slate-100 hover:text-slate-700"
          >
            <CloseIcon className="h-5 w-5" />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}
