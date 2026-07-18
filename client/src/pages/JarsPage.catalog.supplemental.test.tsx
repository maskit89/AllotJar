import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import type { AccountDto, JarDto, MeResponse } from '../types'

// Supplements JarsPage.catalog.test.tsx (which already covers JAR-002/004/005/009/011/
// 013/015/020/021/023/024/025/027/028/031/035/037/039/041/042/043/046/049) and
// JarsPage.test.tsx (JAR-001/003/012/018/019/026/032/034/036/044). This file adds the
// remaining jsdom-observable JAR cases neither file asserts: the dated live-preview
// phrasing (JAR-016), the preview's hide/show gate (JAR-017), the loading state
// (JAR-008), the jar-types InfoHint copy (JAR-022) and a Unicode round-trip (JAR-030).
//
// Same api-control harness as the sibling *.catalog.test.tsx files: vi.hoisted so the
// mock factory can reference the fns, importOriginal spread so the rest of api.ts
// (refreshSession, setSessionHandlers, …) keeps working under the mock — AuthProvider
// reaches into them on mount.
const { mockGet, mockPut, mockPost } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPut: vi.fn(),
  mockPost: vi.fn(),
}))

vi.mock('../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api')>()),
  api: { get: mockGet, put: mockPut, post: mockPost },
  getToken: () => 'test-token',
  setToken: vi.fn(),
}))

import { JarsPage } from './JarsPage'
import { AuthProvider } from '../auth/AuthContext'
// Real (unmocked) money module — pin the active display locale so every €-string
// asserted below renders in the design's canonical en-GB comma-dot format (€1,234.56),
// independent of test-execution order.
import { setMoneyFormat } from '../lib/money'

// accrual defaults to TargetByDate (1) — the method every new jar saves — so the live
// preview mirror is active by default.
function jar(over: Partial<JarDto> = {}): JarDto {
  return {
    id: 'f1',
    name: 'Home insurance',
    kind: 0,
    targetAmount: 300,
    targetDate: '2026-12-01',
    coverStart: null,
    coverEnd: null,
    accrual: 1,
    recurMonths: 12,
    openingBalance: 0,
    openingAsOf: null,
    fundingAccountId: null,
    isArchived: false,
    currentBalance: 120,
    requiredMonthlyContribution: 25,
    projectedFullyFundedDate: '2026-11-01',
    status: 'OnTrack',
    ...over,
  }
}

function me(role: number): MeResponse {
  return { userId: 'u1', email: 'chris@x.com', displayName: 'Chris', role, ownerId: 'u1', memberId: null }
}

// Route the three endpoints JarsPage + AuthProvider hit on mount: /jars, /accounts and
// /auth/me. `jarsPending` leaves the /jars request unresolved (the loading-state case);
// a non-numeric /auth/me role leaves the AuthContext at its Owner default (canWrite).
function mockLoads(
  opts: { jars?: JarDto[]; accounts?: AccountDto[]; meRole?: number; jarsPending?: boolean } = {},
) {
  const { jars = [], accounts = [], meRole, jarsPending = false } = opts
  mockGet.mockImplementation((url: string) => {
    if (url === '/jars') return jarsPending ? new Promise<never>(() => {}) : Promise.resolve({ data: jars })
    if (url === '/accounts') return Promise.resolve({ data: accounts })
    if (url === '/auth/me') return Promise.resolve({ data: meRole === undefined ? {} : me(meRole) })
    return Promise.resolve({ data: {} })
  })
}

function renderPage() {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <JarsPage />
      </AuthProvider>
    </MemoryRouter>,
  )
}

async function openNewJar(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'New jar' }, { timeout: 5000 }))
  return within(await screen.findByRole('dialog', {}, { timeout: 5000 }))
}

describe('JarsPage — catalog supplemental (JAR)', () => {
  beforeEach(() => {
    mockGet.mockReset()
    mockPut.mockReset()
    mockPost.mockReset()
    setMoneyFormat('comma-dot') // pin en-GB: €1,234.56
    mockLoads()
  })

  // --- List, hero & loading -------------------------------------------------

  it('JAR-008: shows "Loading…" over a still-rendered zeroed hero while /jars is in flight', { timeout: 15000 }, async () => {
    // /jars never resolves; Promise.all stays pending, so `loading` stays true.
    mockLoads({ jarsPending: true })

    renderPage()

    // The slate loading line shows…
    expect(await screen.findByText('Loading…', {}, { timeout: 5000 })).toBeInTheDocument()
    // …the hero still renders, zeroed, until data arrives (€0.00 / +€0.00 / 0)…
    const hero = screen.getByText('Total saved').closest('section')!
    expect(within(hero).getByLabelText('Total saved: €0.00')).toBeInTheDocument()
    expect(within(hero).getByText('Monthly').closest('div')!.textContent).toContain('+€0.00')
    expect(within(hero).getByText('Active jars').closest('div')!.textContent).toContain('0')
    // …and neither cards nor the empty state flash before the response resolves.
    expect(screen.queryByRole('heading', { name: 'Your jars' })).not.toBeInTheDocument()
    expect(screen.queryByText(/No jars yet/)).not.toBeInTheDocument()
  })

  // --- New jar modal: the live "set aside" preview --------------------------

  it('JAR-016: the dated preview reads "then it repeats" for Recurring and "until" for a Goal', { timeout: 15000 }, async () => {
    const user = userEvent.setup()

    renderPage()
    const dialog = await openNewJar(user) // Recurring is the default type

    // Recurring + a due date: "… toward <date>, then it repeats".
    await user.type(dialog.getByLabelText('Target amount'), '300')
    fireEvent.change(dialog.getByLabelText('Next due date'), { target: { value: '2026-12-01' } })
    const recurringPreview = await dialog.findByText(/Sets aside/, {}, { timeout: 5000 })
    expect(recurringPreview.textContent).toMatch(/then it repeats/)
    expect(recurringPreview.textContent).not.toMatch(/ until /)

    // Switch to Goal with its own date: " until <date>", never "then it repeats".
    await user.selectOptions(dialog.getByLabelText('Jar type'), '1')
    await user.clear(dialog.getByLabelText('Target amount'))
    await user.type(dialog.getByLabelText('Target amount'), '1200')
    fireEvent.change(dialog.getByLabelText('Target date'), { target: { value: '2027-07-01' } })
    const goalPreview = await dialog.findByText(/Sets aside/, {}, { timeout: 5000 })
    await waitFor(() => expect(goalPreview.textContent).toMatch(/ until /), { timeout: 5000 })
    expect(goalPreview.textContent).not.toMatch(/then it repeats/)
  })

  it('JAR-017: the preview is hidden while the target is blank, 0 or unparseable', { timeout: 15000 }, async () => {
    const user = userEvent.setup()

    renderPage()
    const dialog = await openNewJar(user)

    const target = dialog.getByLabelText('Target amount')
    // Blank target → parses to 0 → no preview.
    expect(dialog.queryByText(/Sets aside/)).not.toBeInTheDocument()
    // Explicit 0 → still no preview.
    await user.type(target, '0')
    expect(dialog.queryByText(/Sets aside/)).not.toBeInTheDocument()
    // Unparseable → no preview.
    await user.clear(target)
    await user.type(target, 'abc')
    expect(dialog.queryByText(/Sets aside/)).not.toBeInTheDocument()
    // A positive parseable target brings the preview back.
    await user.clear(target)
    await user.type(target, '300')
    expect(await dialog.findByText(/Sets aside/, {}, { timeout: 5000 })).toBeInTheDocument()
  })

  // --- Jar-types InfoHint ---------------------------------------------------

  it('JAR-022: the "About jar types" InfoHint explains Recurring and Goal', { timeout: 15000 }, async () => {
    const user = userEvent.setup()

    renderPage()
    const dialog = await openNewJar(user)

    // The trigger is a real <button> beside the Type label (outside the <label>).
    const hint = dialog.getByRole('button', { name: 'About jar types' })
    fireEvent.focus(hint) // reveals the role="tooltip" popover
    const tip = await dialog.findByRole('tooltip', {}, { timeout: 5000 })
    expect(tip.textContent).toContain('Recurring')
    expect(tip.textContent).toMatch(/Saves toward a due date, then repeats/)
    expect(tip.textContent).toContain('Goal')
    expect(tip.textContent).toMatch(/one-off savings target/)
  })

  // --- Create-time round-trip ----------------------------------------------

  it('JAR-030: a Unicode / emoji jar name round-trips verbatim (trimmed only)', { timeout: 15000 }, async () => {
    const name = 'Café ☕ fund 🎉'
    mockPost.mockResolvedValue({ data: jar({ id: 'f9', name, kind: 1, targetAmount: 50, status: 'OnTrack' }) })
    const user = userEvent.setup()

    renderPage()
    const dialog = await openNewJar(user)

    await user.selectOptions(dialog.getByLabelText('Jar type'), '1') // Goal
    // Set the name in one shot (fireEvent.change) so surrogate-pair emoji aren't split
    // by per-keystroke typing; the field is controlled, so this drives the same onChange.
    fireEvent.change(dialog.getByLabelText('Jar name'), { target: { value: name } })
    await user.type(dialog.getByLabelText('Target amount'), '50')
    await user.click(dialog.getByRole('button', { name: 'Add jar' }))

    // The exact string reaches the wire (only trimmed) — no mojibake, no re-encoding.
    await waitFor(
      () => expect(mockPost).toHaveBeenCalledWith('/jars', expect.objectContaining({ name })),
      { timeout: 5000 },
    )
    expect(await screen.findByText(name, {}, { timeout: 5000 })).toBeInTheDocument()
  })
})
