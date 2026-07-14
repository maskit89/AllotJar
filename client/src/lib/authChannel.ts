/**
 * Cross-tab sign-out signal. Without it, logging out (or a session dying) in one tab leaves
 * every other tab holding a working in-memory access token for up to its remaining lifetime,
 * still rendering as signed in. Guarded so environments without BroadcastChannel (old jsdom)
 * just degrade to per-tab behaviour.
 */
const CHANNEL_NAME = 'zbb.auth'

export function broadcastSignOut() {
  if (typeof BroadcastChannel === 'undefined') return
  const channel = new BroadcastChannel(CHANNEL_NAME)
  channel.postMessage('signed-out')
  channel.close()
}

/** Subscribe to sign-outs from OTHER tabs. Returns an unsubscribe function. */
export function onSignOutBroadcast(handler: () => void): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => {}
  const channel = new BroadcastChannel(CHANNEL_NAME)
  channel.onmessage = (event) => {
    if (event?.data === 'signed-out') handler()
  }
  return () => channel.close()
}
