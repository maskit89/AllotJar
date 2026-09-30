// Allocation fixtures the AllocationPage tests share: the source account, the saved profile and
// the preview GET /allocation/preview answers for June 2026.
import type { AccountDto, AllocationProfileDto, AllocationResultDto } from '../../types'

/** Joint Current (acc0), the account the allocation is paid from. */
export const jointCurrent: AccountDto = {
  id: 'acc0', name: 'Joint Current', type: 0, currency: 'EUR', openingBalance: 0, currentBalance: 0, displayOrder: 0,
}

/** The household's profile: paid from acc0, 250 pocket money each, the rest split by balance. */
export function profile(over: Partial<AllocationProfileDto> = {}): AllocationProfileDto {
  return {
    id: 'p1',
    name: 'Household allocation',
    sourceAccountId: 'acc0',
    balanceLeanPercent: 25,
    rules: [
      { id: 'r0', order: 0, type: 0, split: 0, fixedAmountPerMember: 0 },
      { id: 'r1', order: 1, type: 1, split: 0, fixedAmountPerMember: 0 },
      { id: 'r2', order: 2, type: 2, split: 0, fixedAmountPerMember: 250 },
      { id: 'r3', order: 3, type: 3, split: 2, fixedAmountPerMember: 0 },
    ],
    ...over,
  }
}

/** A pool of 8,000.75 split between Alex and Sam; the last step tilts toward Alex's lower balance. */
export function preview(transfersCreated = 0): AllocationResultDto {
  return {
    pool: 8000.75,
    envelopesTotal: 3500,
    jarsTotal: 2000,
    transfersCreated,
    steps: [
      { type: 0, total: 3500, perMember: [{ memberId: 'm1', name: 'Alex', amount: 1750 }, { memberId: 'm2', name: 'Sam', amount: 1750 }] },
      { type: 1, total: 2000, perMember: [{ memberId: 'm1', name: 'Alex', amount: 1000 }, { memberId: 'm2', name: 'Sam', amount: 1000 }] },
      { type: 2, total: 500, perMember: [{ memberId: 'm1', name: 'Alex', amount: 250 }, { memberId: 'm2', name: 'Sam', amount: 250 }] },
      // The terminal step is BalanceTilt (rule r3, split 2), tilting the 2000.75 toward Alex's lower balance.
      { type: 3, total: 2000.75, perMember: [{ memberId: 'm1', name: 'Alex', amount: 1250.47 }, { memberId: 'm2', name: 'Sam', amount: 750.28 }] },
    ],
    members: [
      { memberId: 'm1', name: 'Alex', netIncome: 4200.5, residual: 1250.47, savingsBalance: 30000, savingsAccountId: 'acc1' },
      { memberId: 'm2', name: 'Sam', netIncome: 3800.25, residual: 750.28, savingsBalance: 40000, savingsAccountId: 'acc2' },
    ],
  }
}
