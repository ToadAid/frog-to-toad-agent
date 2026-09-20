export type ExecutionChain = 'base' | 'ethereum'

export type ReceiptFinalityStatus =
  | 'CONFIRMED'
  | 'REVERTED'
  | 'TIMEOUT'
  | 'REORG'
  | 'BALANCE_UNAVAILABLE'
  | 'BALANCE_MISMATCH'
  | 'RPC_UNAVAILABLE'
  | 'INVALID_RECEIPT'

export type ReceiptFinalityRecord = {
  schemaVersion: 1
  key: string
  txHash: string
  chain: ExecutionChain
  status: ReceiptFinalityStatus
  submittedAt: number
  assessedAt: number
  requiredConfirmations: number
  submittedFromAmount: number
  minimumToAmount: number
  balanceToleranceBps: number
  confirmations?: number
  rpc?: string
  blockNumber?: string
  fromToken?: string
  toToken?: string
  reason?: string
  authorityGranted?: false
}
