/**
 * Helper for tools whose capability does not exist in Wave's public GraphQL API.
 *
 * Verified by live schema introspection (2026-06-28, re-checked 2026-09-18): the public
 * schema exposes no money-transaction or bill *reads* (Business has no `transactions`/`bills`
 * field), no transaction update/categorize/delete mutations, and no bill mutations at all.
 *
 * Transaction *writes* are supported - `moneyTransactionCreate` and `moneyTransactionsCreate`
 * are real and reachable, and are implemented by wave_create_transaction /
 * wave_create_transactions. What remains impossible is reading a transaction back or changing
 * one after the fact, which is why those writes validate so strictly before sending.
 *
 * Rather than emit a confusing GraphQL field error, these tools fail with a clear,
 * honest message that points at the working alternatives. The message stays capability-
 * agnostic because bill tools share this helper; anything specific to transactions is
 * passed in by the caller as `detail`.
 */
export function unsupported(capability: string, detail?: string): never {
  throw new Error(
    `${capability} is not supported by Wave's public GraphQL API. ` +
      (detail ? `${detail} ` : '') +
      `For Amazon money movement the SP-API MCP is the source of truth (` +
      `settlements, financial events, and fees), and a CSV export from the Wave web UI ` +
      `(Accounting -> Transactions) shows what is already in Wave.`
  );
}
