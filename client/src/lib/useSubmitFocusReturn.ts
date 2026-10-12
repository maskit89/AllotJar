import { useEffect, useRef } from 'react'

/**
 * A submit button that is disabled while its request runs drops keyboard focus to <body> (the
 * browser cannot keep focus on a disabled control), and the next Tab would then start from the
 * top of the page. When the busy spell ends with the form still on screen and focus nowhere, hand
 * focus back to the form's submit. Returns the ref for the <form>.
 */
export function useSubmitFocusReturn(busy: boolean) {
  const formRef = useRef<HTMLFormElement>(null)
  const wasBusy = useRef(false)
  useEffect(() => {
    if (wasBusy.current && !busy) {
      const active = document.activeElement
      if (!active || active === document.body) {
        formRef.current?.querySelector<HTMLButtonElement>('button[type="submit"]')?.focus()
      }
    }
    wasBusy.current = busy
  }, [busy])
  return formRef
}
