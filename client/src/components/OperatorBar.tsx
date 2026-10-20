import { useEffect, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { useMediaQuery } from '../lib/useMediaQuery'
import { typeIntoField } from '../lib/typeIntoField'

/** The four keys: each types the sign it shows (the amount parser reads − × ÷ as - * /). */
const KEYS = [
  { show: '+', label: 'Plus' },
  { show: '−', label: 'Minus' },
  { show: '×', label: 'Times' },
  { show: '÷', label: 'Divided by' },
] as const

/** An amount field: every money input in the app is a text input with the decimal keypad. */
function isAmountField(el: EventTarget | null): el is HTMLInputElement {
  return el instanceof HTMLInputElement && el.type === 'text' && el.inputMode === 'decimal' && !el.readOnly && !el.disabled
}

/**
 * Where the bar's bottom edge goes: the top of the on-screen keyboard. iOS keeps the layout
 * viewport full height while the keyboard is up and shrinks only the visual viewport, so a fixed
 * `bottom: 0` would sit behind the keyboard; the visual viewport's bottom is the keyboard's top.
 */
function keyboardTop(): number {
  const vv = window.visualViewport
  return vv ? vv.offsetTop + vv.height : window.innerHeight
}

/**
 * The phone's missing calculator keys. Phone number pads (the iPhone's above all) have no + − × ÷,
 * so a sum typed into an amount field ("20+30") could only be typed on a computer. While an amount
 * field has focus on a touch screen, a slim row of the four operators sits on top of the keyboard;
 * a key types its operator at the caret and the field keeps focus (and the keyboard stays up).
 * Nothing shows on a computer, whose keyboard has the keys. Mounted once for the whole app: it
 * follows focus, so every amount field, in a page or a dialog, gets it with no change of its own.
 */
export function OperatorBar() {
  const touch = useMediaQuery('(hover: none) and (pointer: coarse)')
  const [field, setField] = useState<HTMLInputElement | null>(null)
  const [bottom, setBottom] = useState(0)

  useEffect(() => {
    if (!touch) return
    const onFocusIn = (e: FocusEvent) => {
      // A key itself taking focus (a screen reader's double-tap) keeps the bar for its field.
      if (e.target instanceof Element && e.target.closest('[data-operator-bar]')) return
      setField(isAmountField(e.target) ? e.target : null)
    }
    // Focus leaving for nothing (the keyboard closed) hides the bar; focus moving to another
    // field is handled by that field's focusin.
    const onFocusOut = (e: FocusEvent) => {
      if (!e.relatedTarget) setField(null)
    }
    document.addEventListener('focusin', onFocusIn)
    document.addEventListener('focusout', onFocusOut)
    return () => {
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('focusout', onFocusOut)
    }
  }, [touch])

  useEffect(() => {
    if (!field) return
    const place = () => {
      // A field removed while focused (in a browser that sends no focusout for it) takes the bar.
      if (!field.isConnected) setField(null)
      else setBottom(window.innerHeight - keyboardTop())
    }
    place()
    const vv = window.visualViewport
    vv?.addEventListener('resize', place)
    vv?.addEventListener('scroll', place)
    window.addEventListener('resize', place)
    return () => {
      vv?.removeEventListener('resize', place)
      vv?.removeEventListener('scroll', place)
      window.removeEventListener('resize', place)
    }
  }, [field])

  if (!touch || !field || !field.isConnected) return null

  // Pressing a key must not take focus from the field (which would close the keyboard and commit
  // an inline edit), nor reach a dialog's "pressed outside" check (which would close the dialog).
  const hold = (e: ReactPointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }

  return createPortal(
    <div
      role="toolbar"
      aria-label="Calculator keys"
      data-operator-bar
      style={{ bottom }}
      className={`fixed inset-x-0 z-[95] flex gap-1.5 border-t border-slate-200 bg-surface-2/95 pt-1.5 pr-[max(0.5rem,env(safe-area-inset-right))] pl-[max(0.5rem,env(safe-area-inset-left))] ${bottom > 0 ? 'pb-1.5' : 'pb-[max(0.375rem,env(safe-area-inset-bottom))]'} backdrop-blur-md`}
    >
      {KEYS.map((k) => (
        <button
          key={k.show}
          type="button"
          tabIndex={-1}
          aria-label={k.label}
          onPointerDown={hold}
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.stopPropagation()
            typeIntoField(field, k.show)
            field.focus()
          }}
          className="h-10 flex-1 rounded-lg bg-surface text-xl font-medium text-slate-900 shadow-[var(--shadow-frame)] active:bg-slate-200 dark:bg-foreground/10 dark:active:bg-foreground/20"
        >
          {k.show}
        </button>
      ))}
    </div>,
    document.body,
  )
}
