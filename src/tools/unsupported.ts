/**
 * Helper for tools whose capability does not exist in Wave's public GraphQL API.
 *
 * Verified by live schema introspection (2026-06-28): the public schema exposes no
 * money-transaction or bill *reads* (Business has no `transactions`/`bills` field), no
 * transaction update/categorize mutations, and no bill mutations at all. The only
 * transaction *write* is the beta `moneyTransactionCreate`, which requires full
 * double-entry input (anchor + lineItems) and has no matching read query to verify the
 * result - unsafe to expose for bookkeeping.
 *
 * Rather than emit a confusing GraphQL field error, these tools fail with a clear,
 * honest message that points at the working alternatives.
 */
export function unsupported(capability: string, detail?: string): never {
  throw new Error(
    `${capability} is not supported by Wave's public GraphQL API. ` +
      (detail ? `${detail} ` : '') +
      `For Amazon money movement use the SP-API MCP (the source of truth for ` +
      `settlements, financial events, and fees), or export a CSV from the Wave web UI ` +
      `(Accounting -> Transactions).`
  );
}
