import type { ReactNode } from 'react'

/**
 * A tiny in-house inline-SVG icon set — no dependency. Every icon is a 24×24
 * line glyph that inherits colour from `currentColor` and takes a `className`
 * (default `h-5 w-5`), so it themes and sizes with Tailwind utilities. Icons are
 * decorative (`aria-hidden`); their meaning comes from the adjacent label.
 */
function Base({ className = 'h-5 w-5', children }: { className?: string; children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

/** Import — a downward arrow dropping into an open tray. */
export function ImportIcon({ className }: { className?: string }) {
  return (
    <Base className={className}>
      <path d="M12 3v10" />
      <path d="M8 9l4 4 4-4" />
      <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
    </Base>
  )
}

/** Dashboard / budget — a four-pane grid. */
export function DashboardIcon({ className }: { className?: string }) {
  return (
    <Base className={className}>
      <rect x="3" y="3" width="7.5" height="7.5" rx="1.5" />
      <rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5" />
      <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5" />
      <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5" />
    </Base>
  )
}

/** Transactions — up/down transfer arrows. */
export function TransactionsIcon({ className }: { className?: string }) {
  return (
    <Base className={className}>
      <path d="M7 20V4" />
      <path d="M4 7l3-3 3 3" />
      <path d="M17 4v16" />
      <path d="M20 17l-3 3-3-3" />
    </Base>
  )
}

/** Accounts — a payment card. */
export function AccountsIcon({ className }: { className?: string }) {
  return (
    <Base className={className}>
      <rect x="3" y="6" width="18" height="12" rx="2" />
      <path d="M3 10h18" />
      <path d="M7 14.5h3" />
    </Base>
  )
}

/** Funds — a target / bullseye (saving toward a goal). */
export function JarsIcon({ className }: { className?: string }) {
  return (
    <Base className={className}>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="12" cy="12" r="0.6" fill="currentColor" stroke="none" />
    </Base>
  )
}

/** Members — two people. */
export function MembersIcon({ className }: { className?: string }) {
  return (
    <Base className={className}>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 19a5.5 5.5 0 0 1 11 0" />
      <path d="M16 5.3a3 3 0 0 1 0 5.4" />
      <path d="M17.5 13.6A5.5 5.5 0 0 1 20.5 19" />
    </Base>
  )
}

/** Allocation — income splitting into branches. */
export function AllocationIcon({ className }: { className?: string }) {
  return (
    <Base className={className}>
      <path d="M6 3v6a3 3 0 0 0 3 3h9" />
      <path d="M6 21v-6a3 3 0 0 1 3-3" />
      <path d="M15 9l3 3-3 3" />
    </Base>
  )
}

/** Reports — a bar chart. */
export function ReportsIcon({ className }: { className?: string }) {
  return (
    <Base className={className}>
      <path d="M4 20h16" />
      <path d="M7 20v-6" />
      <path d="M12 20V7" />
      <path d="M17 20v-9" />
    </Base>
  )
}

/** Close (×). */
export function CloseIcon({ className }: { className?: string }) {
  return (
    <Base className={className}>
      <path d="M6 6l12 12" />
      <path d="M18 6L6 18" />
    </Base>
  )
}

/** Info — an "i" in a circle. Pairs with a short explanatory popover. */
export function InfoIcon({ className }: { className?: string }) {
  return (
    <Base className={className}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5" />
      <circle cx="12" cy="7.9" r="0.6" fill="currentColor" stroke="none" />
    </Base>
  )
}

/** Sign out — an arrow leaving a container. */
export function LogoutIcon({ className }: { className?: string }) {
  return (
    <Base className={className}>
      <path d="M14 4H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h7" />
      <path d="M16 8l4 4-4 4" />
      <path d="M20 12H10" />
    </Base>
  )
}

/** Check — a tick, for completed steps. */
export function CheckIcon({ className }: { className?: string }) {
  return (
    <Base className={className}>
      <path d="M5 12.5l4.5 4.5L19 7" />
    </Base>
  )
}

/** Chevron down — used to collapse the getting-started panel. */
export function ChevronDownIcon({ className }: { className?: string }) {
  return (
    <Base className={className}>
      <path d="M6 9l6 6 6-6" />
    </Base>
  )
}

/** Access — a key (managing who can sign in). */
export function AccessIcon({ className }: { className?: string }) {
  return (
    <Base className={className}>
      <circle cx="8" cy="8" r="4.5" />
      <path d="M11.2 11.2L20 20" />
      <path d="M17 17l2-2" />
      <path d="M14 14l2-2" />
    </Base>
  )
}

/** Settings — a toothed cog/gear (account & password). Notched outline so it
 *  reads clearly as "settings" and isn't mistaken for the sun/light-mode icon. */
export function SettingsIcon({ className }: { className?: string }) {
  return (
    <Base className={className}>
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </Base>
  )
}

/** Copy — overlapping rectangles, for copy-to-clipboard. */
export function CopyIcon({ className }: { className?: string }) {
  return (
    <Base className={className}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h8" />
    </Base>
  )
}
