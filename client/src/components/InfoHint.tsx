import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { InfoIcon } from './icons'

/**
 * A small "ⓘ" affordance that reveals a short explanation on hover or focus and
 * dismisses on mouse-out, blur, Escape or an outside click. Use it to explain a
 * form field's options inline without crowding the label.
 *
 * Accessibility: the trigger is a real <button> named by `label`; while open it
 * points at the popover via `aria-describedby`, and the popover carries
 * `role="tooltip"`. The pointer handlers sit on the wrapper (which owns the
 * popover in the DOM), so moving from the icon onto the popover keeps it open —
 * satisfying WCAG 2.2 §1.4.13 (content on hover/focus is hoverable, dismissable
 * and persistent). Escape closes the popover alone, never the dialog the hint sits in, and
 * the popover is nudged sideways to stay on screen on the narrowest phones.
 *
 * `fixed` (opt-in, the Allocation page and its sheet dialogs, restyle PR 10) places the popover
 * against the screen instead (see the prop). It stays a child of the wrapper in the DOM, so the
 * pointer handlers, `aria-describedby` and the text around it are the same either way.
 */
export function InfoHint({
  label,
  children,
  className = '',
  align = 'start',
  buttonClassName,
  fixed = false,
}: {
  /** Accessible name for the trigger, e.g. "What repeating means". */
  label: string
  /** Popover body — keep it short. */
  children: ReactNode
  className?: string
  /**
   * Where the popover hangs from the icon: from its left edge (the default, for an icon near
   * the start of a line), or centred under it, for an icon partway across a phone-width line,
   * where a left-hung popover would run off the screen; or from its right edge, for an icon at
   * the end of a line.
   */
  align?: 'start' | 'center' | 'end'
  /**
   * Replaces the trigger's look (size and colour), for a hint on a coloured surface such as the
   * Dashboard's green hero tile. Left out, the trigger is the quiet 16px grey icon.
   */
  buttonClassName?: string
  /**
   * Opt-in: the popover is placed against the screen (position: fixed) from the icon's box, so a
   * scrolling container around it (a sheet dialog's middle) never cuts it off; it opens above the
   * icon when there isn't room for it below (on a page, above a phone's tab bar), and follows the
   * icon while anything scrolls. Left out, the popover hangs below the icon in the page's flow.
   */
  fixed?: boolean
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)
  const hangerRef = useRef<HTMLSpanElement>(null)
  // How far the open popover is moved sideways to keep it inside the viewport.
  const [shift, setShift] = useState(0)
  // `fixed`: where the open popover sits on the screen, and whether it opens above the icon.
  const [at, setAt] = useState<{ top: number; left: number; up: boolean } | null>(null)
  const panelId = useId()

  useEffect(() => {
    if (!open) return
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      // Caught on the way down, before a dialog's own Escape handler: it closes the hint only.
      e.stopPropagation()
      setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  // `fixed`: placed from the icon's box before it is painted, then again whenever anything scrolls
  // or the screen resizes, so it stays with its icon.
  useLayoutEffect(() => {
    if (!fixed || !open) {
      setAt(null)
      return
    }
    function place() {
      const wrap = ref.current
      const hanger = hangerRef.current
      if (!wrap || !hanger) return
      const vw = document.documentElement.clientWidth
      const vh = window.innerHeight
      // Nothing laid out to measure against (a test's DOM): show it where it is.
      if (!vw || !vh) return setAt({ top: 0, left: 0, up: false })
      const margin = 8
      const box = wrap.getBoundingClientRect()
      const width = hanger.offsetWidth
      const height = hanger.offsetHeight
      // The room it may use: the screen, less (on a page, not in a dialog) the sticky top bar and
      // a phone's bottom tab bar.
      let top = margin
      let bottom = vh - margin
      if (!wrap.closest('[role="dialog"]')) {
        const bar = document.querySelector('[data-tabbar]')?.getBoundingClientRect()
        if (bar && bar.height > 0) bottom = Math.min(bottom, bar.top - margin)
        const head = document.querySelector('main header')?.getBoundingClientRect()
        if (head && head.height > 0) top = Math.max(top, head.bottom)
      }
      const below = bottom - box.bottom
      const above = box.top - top
      // Below when it fits there; above when it fits only there; else whichever side has more room.
      const up = height > below && (height <= above || above > below)
      const from = align === 'center' ? box.left + box.width / 2 - width / 2 : align === 'end' ? box.right - width : box.left
      setAt({
        top: up ? box.top - height : box.bottom,
        left: Math.max(margin, Math.min(from, vw - margin - width)),
        up,
      })
    }
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [fixed, open, align])

  // Measured where it first lands (no shift yet), before it is painted.
  useLayoutEffect(() => {
    if (fixed || !open || !hangerRef.current) {
      setShift(0)
      return
    }
    const viewport = document.documentElement.clientWidth
    if (!viewport) return // nothing laid out to measure against
    const margin = 8
    const box = hangerRef.current.getBoundingClientRect()
    const right = viewport - margin
    let dx = box.right > right ? right - box.right : 0
    if (box.left + dx < margin) dx = margin - box.left
    setShift(dx)
  }, [open, fixed])

  return (
    <span
      ref={ref}
      className={`relative inline-flex ${className}`}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        aria-label={label}
        aria-describedby={open ? panelId : undefined}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        className={
          buttonClassName ??
          'inline-flex h-4 w-4 items-center justify-center rounded-full text-slate-400 transition hover:text-slate-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40'
        }
      >
        <InfoIcon className={buttonClassName ? 'h-[15px] w-[15px]' : 'h-4 w-4'} />
      </button>
      {open && (
        // Outer span bridges the gap between icon and card (transparent `pt-1.5`, or `pb-1.5` when it
        // opens above) so the pointer never leaves the wrapper on its way to the popover.
        <span
          ref={hangerRef}
          data-placement={fixed ? (at?.up ? 'above' : 'below') : undefined}
          style={
            fixed
              ? // Unplaced for the one layout pass before it is measured (never painted there).
                { top: at?.top ?? 0, left: at?.left ?? 0, visibility: at ? undefined : 'hidden' }
              : // Hung from its right edge, the popover moves by its right margin (a left margin is ignored there).
                shift
                ? align === 'end'
                  ? { marginRight: -shift }
                  : { marginLeft: shift }
                : undefined
          }
          className={
            fixed
              ? `fixed z-30 w-64 max-w-[calc(100vw-1rem)] ${at?.up ? 'pb-1.5' : 'pt-1.5'}`
              : `absolute top-full z-30 w-64 max-w-[calc(100vw-1rem)] pt-1.5 ${align === 'center' ? 'left-1/2 -translate-x-1/2' : align === 'end' ? 'right-0' : 'left-0'}`
          }
        >
          <span
            id={panelId}
            role="tooltip"
            className="block rounded-lg border border-slate-200 bg-surface p-3 text-left text-xs font-normal leading-relaxed text-slate-600 shadow-card"
          >
            {children}
          </span>
        </span>
      )}
    </span>
  )
}
