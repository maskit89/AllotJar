// Apply the saved (or system) theme before first paint to avoid a flash.
// Kept as an external same-origin script (not inline) so a strict
// Content-Security-Policy `script-src 'self'` covers it without a hash/nonce.
// Loaded synchronously in <head>, so it still runs before the body renders.
(function () {
  try {
    var stored = localStorage.getItem('allotjar.theme')
    var dark =
      stored === 'dark' ||
      (!stored && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches)
    if (dark) document.documentElement.classList.add('dark')
  } catch (e) {}
})()
