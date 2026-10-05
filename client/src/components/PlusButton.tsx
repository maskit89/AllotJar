import type { RefObject } from 'react'

interface PlusButtonProps {
  /** The amount field's current text. */
  value: string
  /** Called with the text to put in the field. */
  onChange: (next: string) => void
  /** The field, so the caret lands after the plus sign (the field's focus handler selects all). */
  inputRef: RefObject<HTMLInputElement | null>
  /** The accessible name, naming the field ("Add to the transaction amount"). */
  label: string
  disabled?: boolean
}

/**
 * A small "+" beside an amount field, for phones: an amount field asks for the number pad
 * (`inputMode="decimal"`), which on an iPhone has no plus key, so a sum ("20+30") could not be
 * typed there (PR #321 review P2-1). The button appends a plus sign to what is typed and puts
 * the caret after it; nothing is added to an empty field or after a plus already there.
 */
export function PlusButton({ value, onChange, inputRef, label, disabled }: PlusButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title="Add another amount to this one"
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        const trimmed = value.trimEnd()
        const next = trimmed === '' || trimmed.endsWith('+') ? trimmed : `${trimmed}+`
        if (next !== value) onChange(next)
        const input = inputRef.current
        if (input) {
          input.focus()
          const end = next.length
          // After the focus handler's select-all, so typing continues after the plus sign.
          window.setTimeout(() => input.setSelectionRange(end, end), 0)
        }
      }}
      className="shrink-0 rounded-lg border border-slate-400 bg-surface px-2.5 text-base font-semibold leading-none text-slate-600 transition hover:bg-slate-50 focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-500/40 disabled:opacity-50"
    >
      +
    </button>
  )
}
