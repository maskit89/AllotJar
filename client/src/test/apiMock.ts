// The one API stand-in the screen tests share.
//
// A screen test mocks `../lib/api` with `apiModule` so a page talks to spies instead of axios:
//
//   vi.mock('../lib/api', async (importOriginal) => (await import('../test/apiMock')).apiModule(importOriginal))
//   import { mockGet, mockPost, resetApiMocks } from '../test/apiMock'
//
// The factory imports this module lazily because vi.mock is hoisted above the file's imports.
// Vitest gives every test file its own module registry, so the spies below belong to that file
// alone; `resetApiMocks()` in a beforeEach wipes their queued answers and call logs between tests.
import { vi } from 'vitest'

type ApiModule = typeof import('../lib/api')

export const mockGet = vi.fn()
export const mockPut = vi.fn()
export const mockPost = vi.fn()
export const mockDelete = vi.fn()

/** What `api` (the axios instance) becomes under test. */
export const mockApi = { get: mockGet, put: mockPut, post: mockPost, delete: mockDelete }

export function resetApiMocks() {
  mockGet.mockReset()
  mockPut.mockReset()
  mockPost.mockReset()
  mockDelete.mockReset()
}

/**
 * The mocked `../lib/api` module. The real module is spread first so newly added api.ts exports
 * keep working under test; `api` becomes the shared spies and `getToken` answers a live token so
 * AuthProvider treats the session as signed in. `over` is the file's own overrides, e.g.
 * `{ getToken: () => null, refreshSession: () => Promise.resolve(null) }` for a signed-out screen
 * or `{ previewImport: mockPreview }` for the import page.
 */
export async function apiModule(
  importOriginal: () => Promise<unknown>,
  over: Partial<ApiModule> = {},
): Promise<ApiModule> {
  return {
    ...((await importOriginal()) as ApiModule),
    api: mockApi as unknown as ApiModule['api'],
    getToken: () => 'test-token',
    setToken: vi.fn(),
    ...over,
  }
}
