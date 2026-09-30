// Renders a screen inside the providers it has in the app, nested the way main.tsx and App.tsx
// nest them: router > auth > features > household > month. Every screen test wraps its page in
// a router and AuthProvider; the other providers are opt-in so a test stays as small as the
// screen it exercises. The providers go in through Testing Library's `wrapper` option, so
// `rerender(<Page />)` keeps the same provider tree (and its state) around the new element.
import type { ReactNode } from 'react'
import { render } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { AuthProvider } from '../auth/AuthContext'
import { FeatureProvider } from '../features/FeatureContext'
import { HouseholdProvider } from '../features/HouseholdContext'
import { MonthProvider } from '../features/MonthContext'

export interface ProviderOptions {
  /** The URL the router starts at (the app's location, e.g. '/accounts/a1'). */
  route?: string
  /** Wrap in FeatureProvider (feature flags from /features). */
  features?: boolean
  /** Wrap in HouseholdProvider (the members list from /members). */
  household?: boolean
  /** Wrap in MonthProvider (the app-wide selected month). */
  month?: boolean
}

/** The provider tree for the given options, as a component Testing Library can wrap a render in. */
export function providersFor({ route, features, household, month }: ProviderOptions = {}) {
  return function Providers({ children }: { children: ReactNode }) {
    let tree = children
    if (month) tree = <MonthProvider>{tree}</MonthProvider>
    if (household) tree = <HouseholdProvider>{tree}</HouseholdProvider>
    if (features) tree = <FeatureProvider>{tree}</FeatureProvider>
    return (
      <MemoryRouter initialEntries={route === undefined ? undefined : [route]}>
        <AuthProvider>{tree}</AuthProvider>
      </MemoryRouter>
    )
  }
}

export function renderWithProviders(ui: ReactNode, options: ProviderOptions = {}) {
  return render(ui, { wrapper: providersFor(options) })
}
