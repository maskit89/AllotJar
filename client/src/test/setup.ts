// Registers the jest-dom matchers (e.g. toBeInTheDocument) and cleans up the
// DOM between tests.
import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

// This jsdom build ships a non-functional localStorage; provide a working
// in-memory one so components that read/write storage can render under test.
class MemoryStorage implements Storage {
  private store = new Map<string, string>()
  get length() {
    return this.store.size
  }
  clear() {
    this.store.clear()
  }
  getItem(key: string) {
    return this.store.has(key) ? this.store.get(key)! : null
  }
  key(index: number) {
    return Array.from(this.store.keys())[index] ?? null
  }
  removeItem(key: string) {
    this.store.delete(key)
  }
  setItem(key: string, value: string) {
    this.store.set(key, String(value))
  }
}

Object.defineProperty(globalThis, 'localStorage', {
  value: new MemoryStorage(),
  writable: true,
  configurable: true,
})

// jsdom has no BroadcastChannel; provide a same-process one so the cross-tab
// sign-out sync (lib/authChannel.ts) is exercisable under test.
if (typeof globalThis.BroadcastChannel === 'undefined') {
  const channels = new Map<string, Set<MemoryBroadcastChannel>>()

  class MemoryBroadcastChannel {
    onmessage: ((event: { data: unknown }) => void) | null = null
    readonly name: string

    constructor(name: string) {
      this.name = name
      if (!channels.has(name)) channels.set(name, new Set())
      channels.get(name)!.add(this)
    }

    postMessage(data: unknown) {
      // Delivered to every OTHER instance on the channel, asynchronously — like the real thing.
      for (const peer of channels.get(this.name) ?? []) {
        if (peer !== this) queueMicrotask(() => peer.onmessage?.({ data }))
      }
    }

    close() {
      channels.get(this.name)?.delete(this)
    }
  }

  Object.defineProperty(globalThis, 'BroadcastChannel', {
    value: MemoryBroadcastChannel,
    writable: true,
    configurable: true,
  })
}

afterEach(() => {
  cleanup()
  localStorage.clear()
})
