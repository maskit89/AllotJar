import { useCallback, useEffect, useState } from 'react'
import { api } from './api'
import type { JarAccountLedgerDto, JarAllocationRequest, JarLedgerLineDto, TransactionJarAllocationDto } from '../types'

/**
 * The jar-backed accounts of the household (GET /jars/ledger), keyed by account id. The jar
 * prompts (rules 78/79) only apply to money moving in or out of one of these accounts, so every
 * money-entry surface asks this hook "does this account back jars, and which?".
 */
export function useJarLedgers(enabled = true) {
  const [ledgers, setLedgers] = useState<JarAccountLedgerDto[]>([])
  // True once a read has succeeded (and false again after one fails): until then an empty list
  // means "not known", not "no jar-backed accounts", so a form must not clear stored jar answers.
  const [loaded, setLoaded] = useState(false)
  const reload = useCallback(() => {
    if (!enabled) return Promise.resolve()
    return api
      .get<JarAccountLedgerDto[]>('/jars/ledger')
      .then(({ data }) => {
        setLedgers(Array.isArray(data) ? data : [])
        setLoaded(true)
      })
      // A failed read only hides the prompts; the server still applies its defaults.
      .catch(() => {
        setLedgers([])
        setLoaded(false)
      })
  }, [enabled])
  useEffect(() => {
    let cancelled = false
    if (!enabled) return
    api
      .get<JarAccountLedgerDto[]>('/jars/ledger')
      .then(({ data }) => {
        if (cancelled) return
        setLedgers(Array.isArray(data) ? data : [])
        setLoaded(true)
      })
      .catch(() => {
        if (cancelled) return
        setLedgers([])
        setLoaded(false)
      })
    return () => {
      cancelled = true
    }
  }, [enabled])
  const byAccount = new Map(ledgers.map((l) => [l.accountId, l]))
  return { ledgers, byAccount, reload, loaded }
}

/** The active jars of one account's ledger, in display order. */
export function activeJars(ledger: JarAccountLedgerDto | undefined): JarLedgerLineDto[] {
  return ledger ? ledger.jars.filter((j) => !j.isArchived) : []
}

/** The stored positive jar amounts of one leg (a rule 78 answer), as request rows to pre-fill a form. */
export function incomingAllocationsOf(
  allocations: TransactionJarAllocationDto[] | undefined,
  accountId: string | null,
): JarAllocationRequest[] {
  if (!allocations || !accountId) return []
  return allocations
    .filter((a) => a.accountId === accountId && a.jarId && a.amount > 0)
    .map((a) => ({ jarId: a.jarId as string, amount: a.amount }))
}

/**
 * The jar an outgoing leg was explicitly drawn from (a rule 79 answer): the stored negative
 * posting on a jar, when one exists. Null means the default (the line's jar, or unallocated).
 */
export function paidFromJarOf(
  allocations: TransactionJarAllocationDto[] | undefined,
  accountId: string | null,
  lineJarIds: Set<string>,
): string | null {
  if (!allocations || !accountId) return null
  const fromJar = allocations.find((a) => a.accountId === accountId && a.jarId && a.amount < 0 && !lineJarIds.has(a.jarId))
  return fromJar?.jarId ?? null
}
