/**
 * Types `text` at the caret the way a keypress would, so React's controlled value follows (its
 * onChange listens for the native input event, and only sees a value set through the prototype's
 * setter). A field that is wholly selected (amount fields select their value on focus) gets the
 * operator after its value instead of in its place: "20" then + reads "20+", not "+".
 */
export function typeIntoField(input: HTMLInputElement, text: string) {
  const value = input.value
  let start = input.selectionStart ?? value.length
  let end = input.selectionEnd ?? value.length
  if (start === 0 && end === value.length) start = end = value.length
  const next = value.slice(0, start) + text + value.slice(end)
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, next)
  input.dispatchEvent(new Event('input', { bubbles: true }))
  const caret = start + text.length
  input.setSelectionRange(caret, caret)
}
