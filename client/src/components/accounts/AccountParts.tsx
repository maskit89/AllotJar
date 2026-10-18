import { Banknote, Coins, CreditCard, Wallet, type LucideIcon } from 'lucide-react'
import { MemberAvatar } from '../MemberAvatar'
import { holderNames } from '../../lib/accountHolders'
import { hueColor, memberHue } from '../../lib/categoryColors'
import type { AccountDto, HouseholdMemberDto } from '../../types'
import { ACCOUNT_TYPE_LABELS, AccountType } from '../../types'

/*
 * An account's look, shared by the Accounts page's cards (restyle PR 6) and an account's own page
 * (restyle PR 11): its type's icon and colour, and who holds it (what its jars hold of it is
 * lib/accountJars). Presentation only; the pages own the data.
 */

/**
 * Each account type's icon and colour (the approved palette: no amber; Cash is clay). Other and
 * the legacy Credit card (rule 75) are not in the mock-up: a banknote in teal, a card in rose.
 */
const TYPE_LOOK: Record<number, { Icon: LucideIcon; color: string }> = {
  [AccountType.Current]: { Icon: CreditCard, color: hueColor('indigo') },
  [AccountType.Savings]: { Icon: Coins, color: hueColor('emerald') },
  [AccountType.Cash]: { Icon: Wallet, color: 'var(--color-clay)' },
  [AccountType.CreditCard]: { Icon: CreditCard, color: hueColor('rose') },
  [AccountType.Other]: { Icon: Banknote, color: hueColor('teal') },
}

/** The account type's icon alone, decorative (opt-in: the Import page's file strip, restyle PR 14, names the account in words beside it). */
export function AccountTypeGlyph({ type, className }: { type: number; className?: string }) {
  const { Icon } = TYPE_LOOK[type] ?? TYPE_LOOK[AccountType.Other]
  return <Icon aria-hidden strokeWidth={1.8} className={className} />
}

/**
 * The account's type as its icon on a tinted tile (named by the type for assistive tech): 44px on
 * a card, 36px in a phone's row (and `small`, beside the editor's name). `detail` (an account's own
 * page, beside the type in words): 44px, 40px on a phone, and decorative, so the type is not read
 * twice.
 */
export function TypeTile({ type, small = false, detail = false, id }: { type: number; small?: boolean; detail?: boolean; id?: string }) {
  const look = TYPE_LOOK[type] ?? TYPE_LOOK[AccountType.Other]
  return (
    <span
      id={id}
      {...(detail ? { 'aria-hidden': true } : { role: 'img', 'aria-label': ACCOUNT_TYPE_LABELS[type] ?? 'Other' })}
      className={`grid shrink-0 place-items-center ${
        detail
          ? 'size-11 rounded-xl [&_svg]:size-5 max-[699.98px]:size-10'
          : small
            ? 'size-9 rounded-[10px] [&_svg]:size-[18px]'
            : `size-11 rounded-xl [&_svg]:size-5 max-[699.98px]:size-9 max-[699.98px]:self-start max-[699.98px]:rounded-[10px] max-[699.98px]:[grid-area:ic] max-[699.98px]:[&_svg]:size-[18px]`
      }`}
      style={{ background: `color-mix(in srgb, ${look.color} 13%, var(--color-card))`, color: look.color }}
    >
      <look.Icon aria-hidden strokeWidth={1.8} />
    </span>
  )
}

/**
 * Who holds the account (rule 30): one avatar each, in the person's colour on People, with their
 * names for assistive tech. Nothing for a household's own account (no holders).
 */
export function HolderAvatars({
  account,
  members,
  avatarClassName = 'size-6 shrink-0 text-xs max-[699.98px]:size-[22px]',
}: {
  account: AccountDto
  members: HouseholdMemberDto[]
  avatarClassName?: string
}) {
  const holders = account.holders ?? []
  if (holders.length === 0) return null
  return (
    <span className="flex gap-1">
      <span className="sr-only">Held by {holderNames(account)}</span>
      {holders.map((h, i) => {
        const at = members.findIndex((m) => m.id === h.memberId)
        return <MemberAvatar key={h.memberId} name={h.name} hue={memberHue(at >= 0 ? at : i)} className={avatarClassName} />
      })}
    </span>
  )
}
