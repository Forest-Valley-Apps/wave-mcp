/**
 * Wave Transaction Tools
 *
 * UNSUPPORTED by Wave's public GraphQL API (verified by live introspection 2026-06-28):
 * - Business exposes no `transactions` field and there is no `transaction(id:)` query,
 *   so transactions cannot be listed, fetched, or have attachments read.
 * - There are no `transactionUpdate` / `transactionCategorize` mutations.
 * - The only transaction *write* is the beta `moneyTransactionCreate`, which requires
 *   full double-entry input (anchor + lineItems) and has no matching read query to
 *   verify the result - a blind write, unsafe to expose for bookkeeping.
 *
 * Each tool is kept registered (so callers get a clear explanation rather than a
 * "tool not found" or a confusing GraphQL field error) but fails via unsupported().
 */

import type { WaveClient } from '../client.js';
import { unsupported } from './unsupported.js';

export function registerTransactionTools(_client: WaveClient) {
  const UNSUPPORTED = '[Unsupported by Wave public API] ';
  return {
    wave_list_transactions: {
      description: UNSUPPORTED + 'List transactions (Wave public API exposes no transaction reads; use SP-API or CSV export)',
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
      handler: async () => unsupported('Listing money transactions'),
    },

    wave_get_transaction: {
      description: UNSUPPORTED + 'Get a transaction (Wave public API exposes no transaction reads; use SP-API or CSV export)',
      parameters: {
        type: 'object',
        properties: {
          businessId: { type: 'string', description: 'Business ID' },
          transactionId: { type: 'string', description: 'Transaction ID' },
        },
        required: ['transactionId'],
      },
      handler: async () => unsupported('Fetching a money transaction'),
    },

    wave_create_transaction: {
      description: UNSUPPORTED + 'Create a transaction (only the beta moneyTransactionCreate exists; blind write, no read-back; use SP-API)',
      parameters: {
        type: 'object',
        properties: {
          businessId: { type: 'string', description: 'Business ID' },
          description: { type: 'string', description: 'Transaction description' },
          date: { type: 'string', description: 'Transaction date (YYYY-MM-DD)' },
          amount: { type: 'string', description: 'Transaction amount' },
          accountId: { type: 'string', description: 'Account ID for categorization' },
        },
        required: ['description', 'date', 'amount', 'accountId'],
      },
      handler: async () =>
        unsupported(
          'Creating a money transaction via a simple description/amount/account',
          'There is no transactionCreate mutation; the only write path is the beta ' +
            'moneyTransactionCreate, which requires full double-entry input (anchor + ' +
            'lineItems) and has no read query to verify the result.'
        ),
    },

    wave_update_transaction: {
      description: UNSUPPORTED + 'Update a transaction (no transactionUpdate mutation exists; use SP-API or CSV export)',
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
      handler: async () => unsupported('Updating a money transaction'),
    },

    wave_categorize_transaction: {
      description: UNSUPPORTED + 'Categorize a transaction (no transactionCategorize mutation exists; use SP-API or CSV export)',
      parameters: {
        type: 'object',
        properties: {
          businessId: { type: 'string', description: 'Business ID' },
          transactionId: { type: 'string', description: 'Transaction ID' },
          accountId: { type: 'string', description: 'New account ID for categorization' },
        },
        required: ['transactionId', 'accountId'],
      },
      handler: async () => unsupported('Categorizing a money transaction'),
    },

    wave_list_transaction_attachments: {
      description: UNSUPPORTED + 'List transaction attachments (Wave public API exposes no transaction reads; use SP-API or CSV export)',
      parameters: {
        type: 'object',
        properties: {
          businessId: { type: 'string', description: 'Business ID' },
          transactionId: { type: 'string', description: 'Transaction ID' },
        },
        required: ['transactionId'],
      },
      handler: async () => unsupported('Listing transaction attachments'),
    },
  };
}
