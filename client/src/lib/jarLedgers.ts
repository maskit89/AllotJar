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
  const read = useCallback(
    (isCurrent: () => boolean = () => true) => {
      if (!enabled) return Promise.resolve()
      return api
        .get<JarAccountLedgerDto[]>('/jars/ledger')
        .then(({ data }) => {
          if (!isCurrent()) return
          setLedgers(readLedgers(data))
          setLoaded(true)
        })
        // A failed read only hides the prompts; the server still applies its defaults.
        .catch(() => {
          if (!isCurrent()) return
          setLedgers([])
          setLoaded(false)
        })
    },
    [enabled],
  )
  const reload = useCallback(() => read(), [read])
  useEffect(() => {
    let cancelled = false
    read(() => !cancelled)
    return () => {
      cancelled = true
    }
  }, [read])
  const byAccount = new Map(ledgers.map((l) => [l.accountId, l]))
  return { ledgers, byAccount, reload, loaded }
}

/**
 * The well-formed ledgers of a GET /jars/ledger answer. A jar in an account whose balance is
 * unavailable (before its opening date) has no balance either: the server sends 0 for it, and
 * rule 67 says an unavailable balance never reads as zero.
 */
export function readLedgers(data: unknown): JarAccountLedgerDto[] {
  if (!Array.isArray(data)) return []
  return (data as JarAccountLedgerDto[])
    .filter((l) => l && typeof l.accountId === 'string' && Array.isArray(l.jars))
    .map((l) => (l.accountBalance === null ? { ...l, jars: l.jars.map((j) => ({ ...j, balance: null })) } : l))
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

/**
 * The archived jar a pre-filled jar answer still names in this account, or null (P3-10). The
 * server won't put money into, or draw from, an archived jar, so an edit that re-sends such an
 * answer can't be saved until the jar is restored.
 */
export function archivedJarNamed(ledger: JarAccountLedgerDto | undefined, jarIds: Iterable<string | null>): JarLedgerLineDto | null {
  if (!ledger) return null
  const ids = new Set(jarIds)
  return ledger.jars.find((j) => j.isArchived && ids.has(j.jarId)) ?? null
}

/** Why an edit naming an archived jar can't be saved (see {@link archivedJarNamed}). */
export function archivedJarMessage(jar: JarLedgerLineDto): string {
  return `This entry moved money in or out of ${jar.name}, which is archived. Restore ${jar.name} on the Jars page to change this entry.`
}
