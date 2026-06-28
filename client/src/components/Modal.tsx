import { useEffect, useRef, type ReactNode } from 'react'
import { useDialogA11y } from '../onboarding/useDialogA11y'
import { CloseIcon } from './icons'

/**
 * An accessible modal dialog: a labelled `role="dialog" aria-modal` card centred
 * over a dimmed backdrop, closing on backdrop click, the ✕, or Escape, with a
 * focus trap + autofocus + focus restore (via useDialogA11y). Mount it
 * conditionally — `{open && <Modal …/>}` — so the trap engages on open. Used by
 * the redesign's add/invite flows (Add transaction, Add account, New jar, Invite).
 */
export function Modal({
  title,
  onClose,
  children,
  size = 'md',
}: {
  title: ReactNode
  onClose: () => void
  children: ReactNode
  size?: 'md' | 'lg'
}) {
  const ref = useRef<HTMLDivElement>(null)
  useDialogA11y(ref, onClose)

  // Lock background scroll while the dialog is open.
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [])

  const width = size === 'lg' ? 'max-w-2xl' : 'max-w-md'

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:items-center">
      <div className="fixed inset-0 bg-black/40" aria-hidden onClick={onClose} />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
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
