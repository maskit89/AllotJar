import { describe, it, expect } from 'vitest'
import { safeInternalPath } from './returnUrl'

describe('safeInternalPath', () => {
  it('accepts a rooted internal path with a query string', () => {
    expect(safeInternalPath('/accept-invite?code=ABC123')).toBe('/accept-invite?code=ABC123')
  })

  it('rejects absolute URLs, scheme-relative URLs and non-rooted values', () => {
    expect(safeInternalPath('https://evil.example')).toBeNull()
    expect(safeInternalPath('//evil.example')).toBeNull()
    expect(safeInternalPath('/\\evil.example')).toBeNull()
    expect(safeInternalPath('accept-invite')).toBeNull()
    expect(safeInternalPath('')).toBeNull()
    expect(safeInternalPath(null)).toBeNull()
  })
})
