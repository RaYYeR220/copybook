/**
 * Errors a move into the perps account can revert with: OpenZeppelin's ERC-20 and SafeERC20 errors on the USDso pull,
 * and the venue's errors about a deposit or an amount. Signatures as in `@somnia-chain/markets-sdk` 0.32.1
 * `contractErrorsAbi`, which is generated from the venue's compiled contracts and the indexer's MarginBank ABI.
 */
export const marginErrorsAbi = [
  { type: "error", name: "ERC20InsufficientAllowance", inputs: [{ name: "spender", type: "address" }, { name: "allowance", type: "uint256" }, { name: "needed", type: "uint256" }] },
  { type: "error", name: "ERC20InsufficientBalance", inputs: [{ name: "sender", type: "address" }, { name: "balance", type: "uint256" }, { name: "needed", type: "uint256" }] },
  { type: "error", name: "SafeERC20FailedOperation", inputs: [{ name: "token", type: "address" }] },
  { type: "error", name: "InvalidDepositOrWithdrawal", inputs: [] },
  { type: "error", name: "InvalidAmount", inputs: [] },
  { type: "error", name: "ZeroAmount", inputs: [] },
  { type: "error", name: "ZeroDeposit", inputs: [] },
] as const;
