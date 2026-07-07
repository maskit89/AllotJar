import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
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
 * and persistent). Mirrors the `UserMenu` popover's Escape / outside-click logic.
 */
export function InfoHint({
  label,
  children,
  className = '',
}: {
  /** Accessible name for the trigger, e.g. "About jar types". */
  label: string
  /** Popover body — keep it short. */
  children: ReactNode
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)
  const panelId = useId()

  useEffect(() => {
    if (!open) return
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
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
        className="inline-flex h-4 w-4 items-center justify-center rounded-full text-slate-400 transition hover:text-slate-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
      >
        <InfoIcon className="h-4 w-4" />
      </button>
      {open && (
        // Outer span bridges the gap between icon and card (transparent `pt-1.5`)
        // so the pointer never leaves the wrapper on its way to the popover.
        <span className="absolute left-0 top-full z-30 w-64 pt-1.5">
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
