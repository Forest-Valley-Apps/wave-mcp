/**
 * Wave Bill Tools (Bills Payable)
 *
 * UNSUPPORTED by Wave's public GraphQL API (verified by live introspection 2026-06-28):
 * the public schema has no bill surface at all - Business exposes no `bills`/`bill(id:)`
 * field, and there are zero bill mutations (no billCreate / billUpdate / billPaymentCreate).
 * So bills cannot be listed, fetched, created, updated, or paid via this API.
 *
 * Each tool is kept registered (so callers get a clear explanation rather than a
 * "tool not found" or a confusing GraphQL field error) but fails via unsupported().
 */

import type { WaveClient } from '../client.js';
import { unsupported } from './unsupported.js';

export function registerBillTools(_client: WaveClient) {
  const UNSUPPORTED = '[Unsupported by Wave public API] ';
  return {
    wave_list_bills: {
      description: UNSUPPORTED + 'List bills (Wave public API has no bill surface; use SP-API or CSV export)',
      parameters: {
        type: 'object',
        properties: {
          businessId: { type: 'string', description: 'Business ID' },
          status: {
            type: 'string',
            enum: ['DRAFT', 'APPROVED', 'PAID', 'PARTIAL'],
            description: 'Filter by bill status'
          },
          vendorId: { type: 'string', description: 'Filter by vendor ID' },
          page: { type: 'number', description: 'Page number (default: 1)' },
          pageSize: { type: 'number', description: 'Results per page (default: 20)' },
        },
      },
      handler: async () => unsupported('Listing bills'),
    },

    wave_get_bill: {
      description: UNSUPPORTED + 'Get a bill (Wave public API has no bill surface; use SP-API or CSV export)',
      parameters: {
        type: 'object',
        properties: {
          businessId: { type: 'string', description: 'Business ID' },
          billId: { type: 'string', description: 'Bill ID' },
        },
        required: ['billId'],
      },
      handler: async () => unsupported('Fetching a bill'),
    },

    wave_create_bill: {
      description: UNSUPPORTED + 'Create a bill (no billCreate mutation exists; use SP-API or CSV export)',
      parameters: {
        type: 'object',
        properties: {
          businessId: { type: 'string', description: 'Business ID' },
          vendorId: { type: 'string', description: 'Vendor ID' },
          billDate: { type: 'string', description: 'Bill date (YYYY-MM-DD)' },
          dueDate: { type: 'string', description: 'Due date (YYYY-MM-DD)' },
          billNumber: { type: 'string', description: 'Bill number/reference' },
          memo: { type: 'string', description: 'Internal memo' },
          items: {
            type: 'array',
            description: 'Bill line items',
            items: {
              type: 'object',
              properties: {
                description: { type: 'string', description: 'Line item description' },
                quantity: { type: 'number', description: 'Quantity' },
                unitPrice: { type: 'string', description: 'Unit price' },
                accountId: { type: 'string', description: 'Expense account ID' },
                taxIds: { type: 'array', items: { type: 'string' }, description: 'Tax IDs to apply' },
              },
              required: ['description', 'quantity', 'unitPrice', 'accountId'],
            },
          },
        },
        required: ['vendorId', 'billDate', 'items'],
      },
      handler: async () => unsupported('Creating a bill'),
    },

    wave_update_bill: {
      description: UNSUPPORTED + 'Update a bill (no billUpdate mutation exists; use SP-API or CSV export)',
      parameters: {
        type: 'object',
        properties: {
          businessId: { type: 'string', description: 'Business ID' },
          billId: { type: 'string', description: 'Bill ID' },
          billNumber: { type: 'string', description: 'Bill number' },
          dueDate: { type: 'string', description: 'Due date (YYYY-MM-DD)' },
          memo: { type: 'string', description: 'Internal memo' },
        },
        required: ['billId'],
      },
      handler: async () => unsupported('Updating a bill'),
    },

    wave_list_bill_payments: {
      description: UNSUPPORTED + 'List bill payments (Wave public API has no bill surface; use SP-API or CSV export)',
      parameters: {
        type: 'object',
        properties: {
          businessId: { type: 'string', description: 'Business ID' },
          billId: { type: 'string', description: 'Bill ID' },
        },
        required: ['billId'],
      },
      handler: async () => unsupported('Listing bill payments'),
    },

    wave_create_bill_payment: {
      description: UNSUPPORTED + 'Record a bill payment (no billPaymentCreate mutation exists; use SP-API or CSV export)',
      parameters: {
        type: 'object',
        properties: {
          businessId: { type: 'string', description: 'Business ID' },
          billId: { type: 'string', description: 'Bill ID' },
          amount: { type: 'string', description: 'Payment amount' },
          date: { type: 'string', description: 'Payment date (YYYY-MM-DD)' },
          source: { type: 'string', description: 'Payment source/method' },
        },
        required: ['billId', 'amount', 'date'],
      },
      handler: async () => unsupported('Recording a bill payment'),
    },
  };
}
