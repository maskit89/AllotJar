import type { HouseholdMemberDto } from '../types'
import { InfoHint } from './InfoHint'

/** The group's one word above its rows, with the explanation behind an (i) (the word alone is uppercase). */
const EYEBROW = 'mb-1 flex items-center gap-1.5 text-xs font-semibold text-slate-500'
const EYEBROW_WORD = 'tracking-[0.04em] uppercase'
/** A styled checkbox row (`.dlg-check` draws the box; `dlg-scope` on the group gives it its colours). */
const ROW = 'dlg-check flex min-h-10 cursor-pointer items-center gap-2.5 text-sm font-medium text-slate-900'

/**
 * W13 (rule 30): who holds an account. None ticked is the household's own account, one is a
 * personal account and two or more a joint one; the account keeps one balance and one history
 * whoever holds it. Styled checkbox rows under a "Holders" eyebrow (restyle PR 18); the boxes keep
 * their names ("Held by Sam", "Sam holds Everyday").
 */
export function HolderPicker({
  members,
  value,
  onChange,
  accountName,
}: {
  members: HouseholdMemberDto[]
  value: string[]
  onChange: (next: string[]) => void
  /** Names the checkboxes for an existing account ("Sam holds Everyday"). */
  accountName?: string
}) {
  if (members.length === 0) return null
  const toggle = (id: string, on: boolean) =>
    onChange(on ? [...value, id] : value.filter((v) => v !== id))
  return (
    <fieldset className="dlg-scope m-0 flex min-w-0 flex-col border-0 p-0">
      <legend className="p-0">
        <span className={EYEBROW}>
          <span className={EYEBROW_WORD}>Holders</span>
          <InfoHint label="About holders">
            None ticked is the household’s own account, one a personal account, two or more a joint one. The account keeps
            one balance and one history whoever holds it.
          </InfoHint>
        </span>
      </legend>
      <div className="flex flex-wrap gap-x-6 gap-y-0.5">
        {members.map((m) => (
          <label key={m.id} className={ROW}>
            <input
              type="checkbox"
              checked={value.includes(m.id)}
              aria-label={accountName ? `${m.name} holds ${accountName}` : `Held by ${m.name}`}
              onChange={(e) => toggle(m.id, e.target.checked)}
            />
            {m.name}
          </label>
        ))}
      </div>
    </fieldset>
  )
}

/** The private-account checkbox shown when the caller adds an account only they hold (rule 31). */
export function PrivateCheckbox({ checked, onChange }: { checked: boolean; onChange: (next: boolean) => void }) {
  return (
    <div className="dlg-scope flex min-w-0 flex-col">
      <span className={EYEBROW}>
        <span className={EYEBROW_WORD}>Privacy</span>
        <InfoHint label="About keeping it private">
          Only you will see it, its balance and its transactions. Money you put on a budget line still shows there. You can
          share it any time.
        </InfoHint>
      </span>
      <label className={ROW}>
        <input type="checkbox" checked={checked} aria-label="Keep this account private" onChange={(e) => onChange(e.target.checked)} />
        Keep it private
      </label>
    </div>
  )
}
