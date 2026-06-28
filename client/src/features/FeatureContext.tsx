import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { api } from '../lib/api'
import type { FeatureFlags } from '../types'

/**
 * Everything on by default — so the UI renders fully until (and unless) a flag is off.
 * `analytics` is the exception: it ships OFF and is only ever on when the server enables it
 * (and a build-time measurement ID exists), so tracking never starts by accident.
 */
const ALL_ON: FeatureFlags = {
  accounts: true,
  multiCurrency: true,
  camtImport: true,
  reports: true,
  jars: true,
  householdAllocation: true,
  analytics: false,
  householdAccess: true,
}

const FeatureContext = createContext<FeatureFlags>(ALL_ON)

/** The active feature flags. Defaults to all-on when no provider is present. */
export function useFeatures(): FeatureFlags {
  return useContext(FeatureContext)
}

/** Loads the server's feature flags once and shares them with the app. */
export function FeatureProvider({ children }: { children: ReactNode }) {
  const [flags, setFlags] = useState<FeatureFlags>(ALL_ON)

  useEffect(() => {
    let cancelled = false
    api
      .get<FeatureFlags>('/features')
      .then(({ data }) => {
        if (!cancelled && data && typeof data === 'object') setFlags({ ...ALL_ON, ...data })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  return <FeatureContext.Provider value={flags}>{children}</FeatureContext.Provider>
}
