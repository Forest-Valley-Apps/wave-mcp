/**
 * Wave Transaction Tools
 *
 * SUPPORTED (verified by live introspection 2026-09-18):
 * - `moneyTransactionCreate` and `moneyTransactionsCreate` (bulk) both exist in the public
 *   schema and are reachable with an ordinary access token. They take full double-entry
 *   input: an `anchor` (the money account, with a direction) plus `lineItems`.
 *
 * UNSUPPORTED by Wave's public GraphQL API:
 * - Business exposes no `transactions` field and there is no `transaction(id:)` query, so
 *   transactions cannot be listed, fetched, or have attachments read. The `Transaction`
 *   object returned by the create mutations exposes only `id`.
 * - There are no `transactionUpdate` / `transactionCategorize` / delete mutations.
 *
 * Those reads and edits are kept registered (so callers get a clear explanation rather than
 * a "tool not found" or a confusing GraphQL field error) but fail via unsupported().
 *
 * Because a posted transaction cannot be read back, amended or removed through the API, the
 * write tools validate hard before sending and default to a content-derived externalId, which
 * is Wave's dedupe key - see ./transaction-input.ts.
 */

import type { WaveClient } from '../client.js';
import { unsupported } from './unsupported.js';
import {
  validateMoneyTransactionDetails,
  type ValidatedTransaction,
} from './transaction-input.js';

const ANCHOR_SCHEMA = {
  type: 'object',
  description:
    'The money account this transaction settles against (bank, credit card, cash). A DEPOSIT ' +
    'debits it, a WITHDRAWAL credits it.',
  properties: {
    accountId: { type: 'string', description: 'Money account ID (from wave_list_accounts)' },
    amount: {
      type: 'string',
      description: 'Unsigned Decimal string, e.g. "100.00". The sign comes from direction.',
    },
    direction: {
      type: 'string',
      enum: ['DEPOSIT', 'WITHDRAWAL'],
      description: 'DEPOSIT = money in, WITHDRAWAL = money out',
    },
  },
  required: ['accountId', 'amount', 'direction'],
};

const LINE_ITEMS_SCHEMA = {
  type: 'array',
  description:
    'The other side of the entry. Must net to the opposite side of the anchor by exactly the ' +
    'anchor amount; splits are allowed (e.g. deposit 100.00 = income 110.00 CREDIT + fee 10.00 DEBIT).',
  items: {
    type: 'object',
    properties: {
      accountId: { type: 'string', description: 'Category account ID (from wave_list_accounts)' },
      amount: { type: 'string', description: 'Unsigned Decimal string, e.g. "10.00"' },
      balance: {
        type: 'string',
        enum: ['DEBIT', 'CREDIT'],
        description:
          'DEBIT or CREDIT. Wave also defines INCREASE/DECREASE, but those are relative to an ' +
          'account\'s normal balance and cannot be balance-checked, so they are not accepted here.',
      },
      customerId: { type: 'string', description: 'Optional customer ID to attribute the line to' },
      description: { type: 'string', description: 'Optional per-line description' },
      taxes: {
        type: 'array',
        description: 'Optional sales taxes; each posts on the same side as its line item.',
        items: {
          type: 'object',
          properties: {
            salesTaxId: { type: 'string', description: 'Sales tax ID (from wave_list_taxes)' },
            amount: { type: 'string', description: 'Unsigned Decimal string' },
          },
          required: ['salesTaxId', 'amount'],
        },
      },
    },
    required: ['accountId', 'amount', 'balance'],
  },
};

const EXTERNAL_ID_DESCRIPTION =
  'Your own ID for this entry; Wave uses it to deduplicate. Omit it and a UUID is derived ' +
  'deterministically from the entry content, so re-running the same import cannot create a ' +
  'second copy: Wave either ignores or rejects the repeat.';

const WRITE_CAVEAT =
  'Wave exposes no way to read back, amend or delete a money transaction through the API, so ' +
  'a wrong entry must be fixed by hand in the Wave web UI. Input is validated and the entry is ' +
  'proved to balance before anything is sent.';

/**
 * Wording that means "Wave already holds this externalId". The *message* has to say so: an error
 * that merely points at the externalId field is just as likely to be a malformed or over-long id,
 * in which case nothing posted at all. Claiming "already posted" for that would hide a missing
 * ledger entry on a write that cannot be read back, so the field path is deliberately not enough.
 */
const DUPLICATE_WORDING =
  /already (exists?|in use|used|taken|posted)|duplicat|not unique|must be unique|unique constraint/i;

/**
 * inputErrors are the only signal available from a write that cannot be read back, and a
 * duplicate externalId is the one failure the documented recovery provokes on purpose (re-send
 * the batch rather than assume nothing posted). Name it, so a retry that hits an entry Wave
 * already holds does not read as a lost posting.
 */
function writeFailureMessage(what: string, inputErrors: unknown): string {
  const looksDuplicate =
    Array.isArray(inputErrors) &&
    inputErrors.some((error: any) => DUPLICATE_WORDING.test(String(error?.message ?? '')));
  return (
    `Failed to ${what}: ${JSON.stringify(inputErrors ?? null)}` +
    (looksDuplicate
      ? ' - this reads as an externalId Wave already holds, i.e. the entry is already posted ' +
        'and was NOT posted twice. Confirm in the Wave web UI; only supply a different ' +
        'externalId if you genuinely want a second, separate entry.'
      : '')
  );
}

/** The mutations return only `id`, so echo back what was sent to give the caller a record. */
function receipt(validated: ValidatedTransaction, id?: string | null) {
  const { details } = validated;
  return {
    id: id ?? null,
    externalId: details.externalId,
    externalIdGenerated: validated.externalIdGenerated,
    // A derived externalId is a function of the entry's content, so a genuine second posting
    // that matches an earlier one field for field carries the same dedupe key and Wave will
    // treat it as the same entry. Say so rather than let it look like two postings landed.
    ...(validated.externalIdGenerated
      ? {
          dedupeNote:
            'externalId was derived from this entry\'s content, so re-sending this exact entry ' +
            'cannot post it twice - Wave ignores or rejects the repeat, and a duplicate/already-' +
            'exists error on a retry means the entry is already in Wave. If you need a second, ' +
            'genuinely separate posting with identical fields, pass an explicit externalId for it.',
        }
      : {}),
    date: details.date,
    description: details.description,
    anchor: details.anchor,
    lineItems: details.lineItems,
  };
}

export function registerTransactionTools(client: WaveClient) {
  const UNSUPPORTED = '[Unsupported by Wave public API] ';

  return {
    wave_create_transaction: {
      description:
        'Create a money transaction (moneyTransactionCreate). Requires full double-entry input: ' +
        'an anchor money account plus balancing line items. ' +
        WRITE_CAVEAT,
      parameters: {
        type: 'object',
        properties: {
          businessId: { type: 'string', description: 'Business ID (defaults to WAVE_BUSINESS_ID)' },
          externalId: { type: 'string', description: EXTERNAL_ID_DESCRIPTION },
          date: { type: 'string', description: 'Transaction date (YYYY-MM-DD)' },
          description: { type: 'string', description: 'Transaction description' },
          notes: { type: 'string', description: 'Optional notes' },
          anchor: ANCHOR_SCHEMA,
          lineItems: LINE_ITEMS_SCHEMA,
        },
        required: ['date', 'description', 'anchor', 'lineItems'],
      },
      handler: async (args: any) => {
        const businessId = args.businessId || client.getBusinessId();
        if (!businessId) throw new Error('businessId required');

        const validated = validateMoneyTransactionDetails(businessId, args, 'transaction');

        const mutation = `
          mutation CreateMoneyTransaction($input: MoneyTransactionCreateInput!) {
            moneyTransactionCreate(input: $input) {
              transaction {
                id
              }
              didSucceed
              inputErrors {
                path
                message
              }
            }
          }
        `;

        const result = await client.mutate(mutation, {
          input: { businessId, ...validated.details },
        });

        if (!result.moneyTransactionCreate.didSucceed) {
          throw new Error(
            writeFailureMessage('create money transaction', result.moneyTransactionCreate.inputErrors)
          );
        }

        return {
          success: true,
          transaction: receipt(validated, result.moneyTransactionCreate.transaction?.id),
        };
      },
    },

    wave_create_transactions: {
      description:
        'Create several money transactions in one call (moneyTransactionsCreate). Intended for ' +
        'fee and settlement imports. Every entry is validated and proved to balance before any ' +
        'of them are sent. Wave does not document whether it applies a batch atomically, so on ' +
        'failure re-send the same batch rather than assume nothing posted: derived externalIds ' +
        'mean whatever already landed cannot post twice, and a duplicate-externalId error on the ' +
        're-send identifies what was already in. ' +
        WRITE_CAVEAT,
      parameters: {
        type: 'object',
        properties: {
          businessId: { type: 'string', description: 'Business ID (defaults to WAVE_BUSINESS_ID)' },
          transactions: {
            type: 'array',
            description: 'The entries to create.',
            items: {
              type: 'object',
              properties: {
                externalId: { type: 'string', description: EXTERNAL_ID_DESCRIPTION },
                date: { type: 'string', description: 'Transaction date (YYYY-MM-DD)' },
                description: { type: 'string', description: 'Transaction description' },
                notes: { type: 'string', description: 'Optional notes' },
                anchor: ANCHOR_SCHEMA,
                lineItems: LINE_ITEMS_SCHEMA,
              },
              required: ['date', 'description', 'anchor', 'lineItems'],
            },
          },
        },
        required: ['transactions'],
      },
      handler: async (args: any) => {
        const businessId = args.businessId || client.getBusinessId();
        if (!businessId) throw new Error('businessId required');

        if (!Array.isArray(args.transactions) || args.transactions.length === 0) {
          throw new Error('transactions is required and must contain at least one transaction');
        }

        // Validate every entry before sending any of them. Wave does not document whether it
        // applies a batch atomically, so a batch that fails server-side may have posted some of
        // its entries - unknowable, on writes that cannot be read back. Rejecting here, with the
        // offending index named and nothing sent, is the only failure mode we can reason about.
        const validated: ValidatedTransaction[] = args.transactions.map((entry: any, index: number) =>
          validateMoneyTransactionDetails(businessId, entry, `transactions[${index}]`)
        );

        const seen = new Map<string, number>();
        validated.forEach((entry, index) => {
          const previous = seen.get(entry.details.externalId);
          if (previous !== undefined) {
            throw new Error(
              `transactions[${index}] repeats the externalId of transactions[${previous}] ` +
                `(${entry.details.externalId}) and nothing was sent. Two entries with the same ` +
                `externalId are the same entry to Wave. If they are genuinely different postings, ` +
                `give each an explicit externalId; if they are duplicates, send only one.`
            );
          }
          seen.set(entry.details.externalId, index);
        });

        const mutation = `
          mutation CreateMoneyTransactions($input: MoneyTransactionsCreateInput!) {
            moneyTransactionsCreate(input: $input) {
              transactions {
                id
              }
              didSucceed
              inputErrors {
                path
                message
              }
            }
          }
        `;

        const result = await client.mutate(mutation, {
          input: {
            businessId,
            transactions: validated.map((entry) => entry.details),
          },
        });

        if (!result.moneyTransactionsCreate.didSucceed) {
          throw new Error(
            writeFailureMessage(
              'create money transactions',
              result.moneyTransactionsCreate.inputErrors
            )
          );
        }

        // Wave returns ids in a bare list with nothing tying one to an input entry, so they can
        // only be paired positionally, and only when the counts match. A short or long list
        // would otherwise attach the wrong Wave id to an entry in the caller's record.
        const ids: Array<{ id: string } | null> = result.moneyTransactionsCreate.transactions ?? [];
        const idsAlign = ids.length === validated.length;
        return {
          success: true,
          created: validated.length,
          ...(idsAlign
            ? {}
            : {
                idsUnmatched:
                  `Wave returned ${ids.length} transaction id(s) for ${validated.length} entries, ` +
                  `so ids are not attached below. Wave reported success, so the entries are ` +
                  `expected to have posted, but that cannot be confirmed through the API: check ` +
                  `the Wave web UI by date and description.`,
              }),
          transactions: validated.map((entry, index) =>
            receipt(entry, idsAlign ? ids[index]?.id : null)
          ),
        };
      },
    },

    wave_list_transactions: {
      description:
        UNSUPPORTED +
        'List transactions (Wave public API exposes no transaction reads; use SP-API or CSV export)',
      parameters: {
        type: 'object',
        properties: {
          businessId: { type: 'string', description: 'Business ID' },
          accountId: { type: 'string', description: 'Filter by specific account ID' },
          startDate: { type: 'string', description: 'Start date (YYYY-MM-DD)' },
          endDate: { type: 'string', description: 'End date (YYYY-MM-DD)' },
          page: { type: 'number', description: 'Page number (default: 1)' },
          pageSize: { type: 'number', description: 'Results per page (default: 50)' },
        },
      },
      handler: async () =>
        unsupported(
          'Listing money transactions',
          'Transactions can be created with wave_create_transaction / wave_create_transactions, ' +
            'but the public schema has no transaction query, so none can be read back.'
        ),
    },

    wave_get_transaction: {
      description:
        UNSUPPORTED +
        'Get a transaction (Wave public API exposes no transaction reads; use SP-API or CSV export)',
      parameters: {
        type: 'object',
        properties: {
          businessId: { type: 'string', description: 'Business ID' },
          transactionId: { type: 'string', description: 'Transaction ID' },
        },
        required: ['transactionId'],
      },
      handler: async () =>
        unsupported(
          'Fetching a money transaction',
          'Transactions can be created with wave_create_transaction / wave_create_transactions, ' +
            'but the public schema has no transaction query, so none can be read back.'
        ),
    },

    wave_update_transaction: {
      description:
        UNSUPPORTED +
        'Update a transaction (no transactionUpdate mutation exists; correct it in the Wave web UI)',
      parameters: {
        type: 'object',
        properties: {
          businessId: { type: 'string', description: 'Business ID' },
          transactionId: { type: 'string', description: 'Transaction ID' },
          description: { type: 'string', description: 'Transaction description' },
          date: { type: 'string', description: 'Transaction date (YYYY-MM-DD)' },
        },
        required: ['transactionId'],
      },
      handler: async () =>
        unsupported(
          'Updating a money transaction',
          'Transactions can be created via wave_create_transaction but never edited through the ' +
            'API; there is no transactionUpdate mutation and no way to read one back.'
        ),
    },

    wave_categorize_transaction: {
      description:
        UNSUPPORTED +
        'Categorize a transaction (no transactionCategorize mutation exists; categorize in the Wave web UI)',
      parameters: {
        type: 'object',
        properties: {
          businessId: { type: 'string', description: 'Business ID' },
          transactionId: { type: 'string', description: 'Transaction ID' },
          accountId: { type: 'string', description: 'New account ID for categorization' },
        },
        required: ['transactionId', 'accountId'],
      },
      handler: async () =>
        unsupported(
          'Categorizing a money transaction',
          'Categories are set at creation time through lineItems[].accountId; an existing ' +
            'transaction, such as one pulled in by a bank feed, cannot be re-categorized via the API.'
        ),
    },

    wave_list_transaction_attachments: {
      description:
        UNSUPPORTED +
        'List transaction attachments (Wave public API exposes no transaction reads; use SP-API or CSV export)',
      parameters: {
        type: 'object',
        properties: {
          businessId: { type: 'string', description: 'Business ID' },
          transactionId: { type: 'string', description: 'Transaction ID' },
        },
        required: ['transactionId'],
      },
      handler: async () =>
        unsupported(
          'Listing transaction attachments',
          'Attachments hang off a transaction, and transactions cannot be read at all.'
        ),
    },
  };
}
