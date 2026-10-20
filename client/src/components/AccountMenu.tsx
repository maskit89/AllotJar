import { useId } from 'react'
import { Link } from 'react-router-dom'
import { ChevronsUpDown, LogOut, Moon, Settings2 } from 'lucide-react'
import { useAuth } from '../auth/AuthContext'
import { EVENTS, track } from '../analytics'
import { useTheme } from '../lib/theme'
import { useAccountIdentity } from './accountIdentity'
import { SwitchTrack } from './ThemeToggle'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu'

/**
 * The signed-in person's avatar: their initials on the brand green, ringed in gold. `ring` is the
 * colour of the gap between the circle and the ring (the surface the avatar sits on).
 */
export function AccountAvatar({ size = 34, ring = 'var(--color-side)' }: { size?: number; ring?: string }) {
  const { initials } = useAccountIdentity()
  return (
    <span
      aria-hidden
      className="grid shrink-0 place-items-center rounded-full bg-primary font-semibold text-white"
      style={{
        width: size,
        height: size,
        fontSize: size >= 34 ? 14 : 13,
        boxShadow: `0 0 0 2px ${ring}, 0 0 0 3.5px var(--gold-line)`,
      }}
    >
      {initials}
    </span>
  )
}

/**
 * A row of the menu, as in the mock-ups: 38px, a 16px icon column, and a quiet highlight under the
 * pointer or the keyboard (the inset surface in light, the text colour at 7% on the raised dark
 * menu) with the text staying the menu's own colour.
 */
const ITEM =
  "h-[38px] gap-2.5 rounded-lg px-2.5 text-sm font-medium text-popover-foreground focus:bg-surface-2 focus:text-popover-foreground dark:focus:bg-foreground/7 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground"

const RADIO_DOT =
  '*:data-[slot=dropdown-menu-radio-item-indicator]:left-2.5 *:data-[slot=dropdown-menu-radio-item-indicator]:size-4'

/**
 * The account menu, opened from the sidebar's profile button on desktop and from the avatar in the
 * phone top bar: the household switcher (only when the login belongs to several), Account
 * settings, the Dark mode switch and Sign out. It is a Radix menu, so arrow keys move through it,
 * Escape closes it and focus returns to the button that opened it. It is non-modal (like the
 * menu it replaced): the page around it is not hidden from assistive tech while it is open, and a
 * click or focus outside closes it.
 */
export function AccountMenu({ variant, current = false }: { variant: 'sidebar' | 'avatar'; current?: boolean }) {
  const { households, switchHousehold, logout } = useAuth()
  const householdLabelId = useId()
  const { name, householdLabel } = useAccountIdentity()
  const { isDark, setMode } = useTheme()
  const multi = households.length > 1
  const active = households.find((h) => h.isActive)?.ownerId ?? ''
  const sidebar = variant === 'sidebar'

  return (
    <DropdownMenu modal={false}>
      {sidebar ? (
        <DropdownMenuTrigger
          // On the Account page the button is where you are: pressed (raised), like the current
          // nav item, and marked as the current page.
          aria-current={current ? 'page' : undefined}
          className={`flex w-full items-center gap-2.5 rounded-xl p-2.5 text-left transition-colors data-[state=open]:bg-surface data-[state=open]:shadow-[var(--shadow-frame)] ${
            current
              ? 'bg-surface text-slate-900 shadow-[var(--shadow-frame)] forced-colors:border forced-colors:border-[color:CanvasText]'
              : 'text-slate-500 hover:bg-surface/55'
          }`}
        >
          <AccountAvatar />
          {/* One spoken name for the button, "Account menu: name, household": the visible words
              read inside it (WCAG 2.5.3), the rest is screen-reader text. */}
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="sr-only">Account menu:</span>{' '}
            {name && <span className="truncate text-sm font-semibold text-slate-900">{name}</span>}
            {name && householdLabel && (
              <>
                <span className="sr-only">,</span>{' '}
              </>
            )}
            <span className="truncate text-xs">{householdLabel}</span>
          </span>
          <ChevronsUpDown aria-hidden strokeWidth={1.8} className="size-3.5 shrink-0" />
        </DropdownMenuTrigger>
      ) : (
        <DropdownMenuTrigger
          aria-label="Account menu"
          // 40px as in the mock-up, with a 44px touch target (the ::after) for the thumb.
          className="relative grid size-10 shrink-0 place-items-center rounded-full after:absolute after:-inset-0.5 after:content-['']"
        >
          <AccountAvatar size={30} ring="var(--color-background)" />
        </DropdownMenuTrigger>
      )}
      <DropdownMenuContent
        side={sidebar ? 'top' : 'bottom'}
        align={sidebar ? 'start' : 'end'}
        sideOffset={8}
        className="w-[220px] rounded-xl p-1.5 shadow-[var(--shadow-frame-lg)]"
      >
        {multi && (
          <>
            <DropdownMenuLabel
              id={householdLabelId}
              className="px-2.5 pt-1.5 pb-1 text-xs font-semibold tracking-[0.05em] text-slate-500 uppercase"
            >
              Household
            </DropdownMenuLabel>
            {/* Named by the label above, so each choice is heard as a household. */}
            <DropdownMenuRadioGroup
              aria-labelledby={householdLabelId}
              value={active}
              onValueChange={(ownerId) => {
                if (ownerId !== active) void switchHousehold(ownerId)
              }}
            >
              {households.map((h) => (
                // The bullet sits in the rows' 16px icon column, so every label below starts at
                // the same x.
                <DropdownMenuRadioItem key={h.ownerId} value={h.ownerId} className={`${ITEM} pl-9 ${RADIO_DOT}`}>
                  <span className="truncate">{h.label}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator className="mx-1 my-1.5" />
          </>
        )}
        <DropdownMenuItem asChild className={ITEM}>
          <Link to="/account">
            <Settings2 aria-hidden strokeWidth={1.8} />
            Account settings
          </Link>
        </DropdownMenuItem>
        {/* The row is the switch: a menu checkbox item, drawn as a switch. Choosing it keeps the
            menu open so the new theme shows around it. */}
        <DropdownMenuCheckboxItem
          checked={isDark}
          onCheckedChange={(on) => setMode(on ? 'dark' : 'light')}
          onSelect={(e) => e.preventDefault()}
          className={`${ITEM} *:data-[slot=dropdown-menu-checkbox-item-indicator]:hidden`}
        >
          <Moon aria-hidden strokeWidth={1.8} />
          Dark mode
          <SwitchTrack on={isDark} />
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator className="mx-1 my-1.5" />
        <DropdownMenuItem
          className={ITEM}
          onSelect={() => {
            track(EVENTS.logout)
            logout()
          }}
        >
          <LogOut aria-hidden strokeWidth={1.8} />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
