import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const mockDownload = vi.fn()
vi.mock('../../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api')>()),
  downloadMyData: () => mockDownload(),
}))

import { DownloadDataCard } from './DownloadDataCard'

describe('DownloadDataCard', () => {
  beforeEach(() => mockDownload.mockReset())

  it('downloads the zip, saying so while it is prepared', async () => {
    let finish: () => void = () => {}
    mockDownload.mockReturnValue(new Promise<void>((resolve) => (finish = resolve)))
    const user = userEvent.setup()
    render(<DownloadDataCard />)

    expect(screen.getByRole('heading', { name: 'Your data' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Download' }))

    expect(mockDownload).toHaveBeenCalledTimes(1)
    const busy = screen.getByRole('button', { name: 'Preparing…' })
    expect(busy).toHaveAttribute('aria-disabled', 'true')
    finish()
    expect(await screen.findByRole('button', { name: 'Download' })).not.toHaveAttribute('aria-disabled')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('runs one download at a time, even from the keyboard', async () => {
    let finish: () => void = () => {}
    mockDownload.mockReturnValue(new Promise<void>((resolve) => (finish = resolve)))
    const user = userEvent.setup()
    render(<DownloadDataCard />)

    screen.getByRole('button', { name: 'Download' }).focus()
    await user.keyboard('{Enter}')
    await user.keyboard('{Enter}')
    await user.keyboard(' ')
    expect(mockDownload).toHaveBeenCalledTimes(1)
    finish()
    await screen.findByRole('button', { name: 'Download' })
  })

  it('says when the download could not be prepared, and lets them try again', async () => {
    mockDownload.mockRejectedValueOnce(new Error('500')).mockResolvedValueOnce(undefined)
    const user = userEvent.setup()
    render(<DownloadDataCard />)

    await user.click(screen.getByRole('button', { name: 'Download' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not prepare your download.')

    await user.click(screen.getByRole('button', { name: 'Download' }))
    expect(mockDownload).toHaveBeenCalledTimes(2)
    await vi.waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  })
})
