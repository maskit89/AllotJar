import { useState } from 'react'
import { Download } from 'lucide-react'
import { InfoHint } from '../InfoHint'
import { CARD_TITLE, DASH_CARD } from '../budget/card'
import { downloadMyData } from '../../lib/api'
import { OUTLINE_SM, ROW, ROW_HINT, ROW_TITLE, Tile } from './parts'

/**
 * Account settings' "Your data" card (compliance fix 4): one row, Download my data, which saves the
 * server's zip of everything this login can see in the household it is viewing. What is in it sits
 * behind the (i), as the page's other explanations do.
 */
export function DownloadDataCard() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onDownload() {
    // aria-disabled keeps the focus, so Enter or Space still reach here while it works.
    if (busy) return
    setError(null)
    setBusy(true)
    try {
      await downloadMyData()
    } catch {
      setError('Could not prepare your download. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section aria-labelledby="as-data" className={DASH_CARD}>
      <h2 id="as-data" className={`mb-3.5 flex min-h-8 items-center ${CARD_TITLE}`}>
        Your data
      </h2>
      <div className="flex flex-col">
        <div className={`${ROW} flex-wrap`}>
          <Tile color="var(--color-steel)">
            <Download strokeWidth={1.8} />
          </Tile>
          <span className="flex min-w-0 flex-[1_1_auto] items-center gap-1">
            <h3 className={ROW_TITLE}>Download my data</h3>
            <InfoHint label="About the download" buttonClassName={ROW_HINT} align="end" fixed>
              A zip of everything you can see in this household: one JSON file and a CSV for each table. Accounts
              someone else keeps private are not included.
            </InfoHint>
          </span>
          <button type="button" onClick={() => void onDownload()} aria-disabled={busy || undefined} className={`${OUTLINE_SM} ml-auto aria-disabled:pointer-events-none aria-disabled:opacity-50`}>
            {busy ? 'Preparing…' : 'Download'}
          </button>
        </div>
      </div>
      {error && (
        <p role="alert" className="auth-error mt-2">
          {error}
        </p>
      )}
    </section>
  )
}
