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
 */
export function InfoHint({
  label,
  children,
  className = '',
  align = 'start',
  buttonClassName,
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
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)
  const hangerRef = useRef<HTMLSpanElement>(null)
  // How far the open popover is moved sideways to keep it inside the viewport.
  const [shift, setShift] = useState(0)
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

  // Measured where it first lands (no shift yet), before it is painted.
  useLayoutEffect(() => {
    if (!open || !hangerRef.current) {
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
  }, [open])

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
        // Outer span bridges the gap between icon and card (transparent `pt-1.5`)
        // so the pointer never leaves the wrapper on its way to the popover.
        <span
          ref={hangerRef}
          style={shift ? { marginLeft: shift } : undefined}
          className={`absolute top-full z-30 w-64 max-w-[calc(100vw-1rem)] pt-1.5 ${align === 'center' ? 'left-1/2 -translate-x-1/2' : align === 'end' ? 'right-0' : 'left-0'}`}
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
