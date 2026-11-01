import { beforeEach, describe, expect, it, vi } from 'vitest'
import { moveLegacyStorage } from './legacyStorage'

describe('moveLegacyStorage', () => {
  beforeEach(() => localStorage.clear())

  it('moves every zbb.* preference to the same name under allotjar.', () => {
    localStorage.setItem('zbb.theme', 'dark')
    localStorage.setItem('zbb.currency', 'GBP')
    localStorage.setItem('zbb.onboarding:u-me', '{"v":1,"welcomeSeen":true}')
    moveLegacyStorage()
    expect(localStorage.getItem('allotjar.theme')).toBe('dark')
    expect(localStorage.getItem('allotjar.currency')).toBe('GBP')
    expect(localStorage.getItem('allotjar.onboarding:u-me')).toBe('{"v":1,"welcomeSeen":true}')
    expect(localStorage.getItem('zbb.theme')).toBeNull()
    expect(localStorage.getItem('zbb.currency')).toBeNull()
    expect(localStorage.getItem('zbb.onboarding:u-me')).toBeNull()
  })

  it('removes the old identity keys without moving them', () => {
    localStorage.setItem('zbb.email', 'old@x.com')
    localStorage.setItem('zbb.role', '0')
    localStorage.setItem('zbb.displayName', 'Old')
    localStorage.setItem('zbb.token', 'tok')
    moveLegacyStorage()
    for (const name of ['email', 'role', 'displayName', 'token']) {
      expect(localStorage.getItem(`zbb.${name}`)).toBeNull()
      expect(localStorage.getItem(`allotjar.${name}`)).toBeNull()
    }
  })

  it('keeps a value already saved under the new name', () => {
    localStorage.setItem('zbb.theme', 'dark')
    localStorage.setItem('allotjar.theme', 'light')
    moveLegacyStorage()
    expect(localStorage.getItem('allotjar.theme')).toBe('light')
    expect(localStorage.getItem('zbb.theme')).toBeNull()
  })

  it('leaves keys of other prefixes alone and is a no-op the second time', () => {
    localStorage.setItem('other.key', 'x')
    localStorage.setItem('zbbx', 'y')
    localStorage.setItem('zbb.jarSort', 'name')
    moveLegacyStorage()
    moveLegacyStorage()
    expect(localStorage.getItem('other.key')).toBe('x')
    expect(localStorage.getItem('zbbx')).toBe('y')
    expect(localStorage.getItem('allotjar.jarSort')).toBe('name')
    expect(localStorage.length).toBe(3)
  })

  it('does not throw when storage is unavailable', () => {
    const broken = {
      get length(): number {
        throw new Error('blocked')
      },
      key: vi.fn(),
      getItem: vi.fn(),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn(),
    } as unknown as Storage
    expect(() => moveLegacyStorage(broken)).not.toThrow()
  })
})
