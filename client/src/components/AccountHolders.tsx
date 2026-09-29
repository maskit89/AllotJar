import type { HouseholdMemberDto } from '../types'

const CHECKBOX = 'h-4 w-4 rounded border-slate-400 text-brand-600 focus:ring-2 focus:ring-brand-500/40'

/**
 * W13 (rule 30): who holds an account. None ticked is the household's own account, one is a
 * personal account and two or more a joint one; the account keeps one balance and one history
 * whoever holds it.
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
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1 text-xs font-medium text-slate-500">
        Held by{' '}
        <span className="font-normal text-slate-400">
          (none: the household’s own; two or more: a joint account)
        </span>
      </legend>
      <div className="flex flex-wrap gap-x-4 gap-y-1.5">
        {members.map((m) => (
          <label key={m.id} className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={value.includes(m.id)}
              aria-label={accountName ? `${m.name} holds ${accountName}` : `Held by ${m.name}`}
              onChange={(e) => toggle(m.id, e.target.checked)}
              className={CHECKBOX}
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
    <label className="flex items-start gap-2 text-sm text-slate-700">
      <input
        type="checkbox"
        checked={checked}
        aria-label="Keep this account private"
        onChange={(e) => onChange(e.target.checked)}
        className={`mt-0.5 ${CHECKBOX}`}
      />
      <span>
        Keep it private
        <span className="block text-xs text-slate-500">
          Only you will see it, its balance and its transactions. Money you put on a budget line still shows there. You
          can share it any time.
        </span>
      </span>
    </label>
  )
}
