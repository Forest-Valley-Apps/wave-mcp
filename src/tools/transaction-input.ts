/**
 * Input handling for Wave money-transaction writes.
 *
 * These writes are one-way: `moneyTransactionCreate` / `moneyTransactionsCreate` are the
 * only transaction mutations in the public schema, the returned `Transaction` object
 * exposes nothing but `id`, and there is no transaction query, update or delete. A bad
 * write therefore cannot be read back, corrected or removed through the API - it has to be
 * fixed by hand in the Wave web UI. Everything here exists to catch mistakes *before* they
 * are sent:
 *
 * - `deterministicExternalId` makes a re-run of the same entry reuse the same externalId,
 *   which is Wave's dedupe key, so a retry cannot silently double-post.
 * - `validateMoneyTransactionDetails` rejects malformed amounts/dates/enums and proves the
 *   entry balances as double entry.
 */

import { createHash } from 'node:crypto';

/** Fixed namespace so a given entry always derives the same externalId. Do not change. */
const EXTERNAL_ID_NAMESPACE = '9f1c3f9a-7b4e-5c2d-9a3f-1e8b6c4d2a70';

export type TransactionDirection = 'DEPOSIT' | 'WITHDRAWAL';

/**
 * Wave's BalanceType also has INCREASE/DECREASE, which are relative to an account's normal
 * balance and so cannot be checked without knowing each account's type. Writes here are
 * restricted to the unambiguous DEBIT/CREDIT pair so the balance check below is meaningful.
 */
export type BalanceType = 'DEBIT' | 'CREDIT';

export interface SalesTaxInput {
  salesTaxId: string;
  amount: string;
}

export interface AnchorInput {
  accountId: string;
  amount: string;
  direction: TransactionDirection;
}

export interface LineItemInput {
  accountId: string;
  amount: string;
  balance: BalanceType;
  customerId?: string;
  description?: string;
  taxes?: SalesTaxInput[];
}

/** Matches Wave's MoneyTransactionDetails (the per-entry shape used by both mutations). */
export interface MoneyTransactionDetails {
  externalId: string;
  date: string;
  description: string;
  notes?: string;
  anchor: AnchorInput;
  lineItems: LineItemInput[];
}

export interface ValidatedTransaction {
  details: MoneyTransactionDetails;
  /** True when externalId was derived from the entry rather than supplied by the caller. */
  externalIdGenerated: boolean;
}

/**
 * Wave Decimal values are strings ("100.00"), never numbers, and are unsigned - the
 * direction/balance fields carry the sign. Parsed to integer cents so the balance check is
 * exact rather than subject to binary floating point.
 */
function parseAmountToCents(raw: unknown, field: string): number {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error(
      `${field} must be a Decimal string such as "100.00" (Wave rejects numbers); got ${JSON.stringify(raw)}`
    );
  }
  const value = raw.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(value)) {
    throw new Error(
      `${field} must be an unsigned Decimal string with at most 2 decimal places, such as ` +
        `"100.00" - the sign is carried by anchor.direction and lineItems[].balance, not by ` +
        `the amount; got ${JSON.stringify(raw)}`
    );
  }
  const [whole, fraction = ''] = value.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents)) {
    throw new Error(`${field} is too large to represent exactly: ${value}`);
  }
  if (cents === 0) {
    throw new Error(`${field} must be greater than zero; got ${value}`);
  }
  return cents;
}

function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/**
 * C0/DEL control characters are rejected everywhere. They have no place in a ledger entry, and
 * `deterministicExternalId` below joins an entry's fields with a unit separator - if a field
 * could itself contain one, two different entries could join to the same string and so derive
 * the same externalId.
 */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function rejectControlCharacters(value: string, field: string): string {
  if (CONTROL_CHARACTERS.test(value)) {
    throw new Error(`${field} must not contain control characters`);
  }
  return value;
}

function requireNonEmptyString(raw: unknown, field: string): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error(`${field} is required and must be a non-empty string`);
  }
  return rejectControlCharacters(raw.trim(), field);
}

/**
 * Optional free-text field. An absent value and an explicit empty string both mean "not set":
 * callers routinely send "" for a field they have nothing for, and rejecting that with
 * "is required" would block an otherwise valid entry over a blank note.
 */
function optionalString(raw: unknown, field: string): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') {
    throw new Error(`${field} must be a string when provided`);
  }
  const value = raw.trim();
  return value === '' ? undefined : rejectControlCharacters(value, field);
}

function requireDate(raw: unknown, field: string): string {
  const value = requireNonEmptyString(raw, field);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${field} must be in YYYY-MM-DD format; got ${JSON.stringify(raw)}`);
  }
  // Reject calendar-invalid dates such as 2026-02-30, which the regex alone admits.
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new Error(`${field} is not a real calendar date: ${value}`);
  }
  return value;
}

function requireEnum<T extends string>(raw: unknown, field: string, allowed: readonly T[]): T {
  const value = requireNonEmptyString(raw, field).toUpperCase();
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`${field} must be one of ${allowed.join(' | ')}; got ${JSON.stringify(raw)}`);
  }
  return value as T;
}

/**
 * RFC 4122 v5 UUID (SHA-1 over namespace + name). Deterministic by construction: the same
 * entry always yields the same externalId, so re-running an import cannot create a duplicate
 * posting (Wave dedupes on externalId; whether it ignores or rejects the repeat is its own
 * behaviour and cannot be observed from here, since transactions cannot be read back).
 */
function uuidV5(name: string): string {
  const namespaceBytes = Buffer.from(EXTERNAL_ID_NAMESPACE.replace(/-/g, ''), 'hex');
  const digest = createHash('sha1').update(namespaceBytes).update(Buffer.from(name, 'utf8')).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

/**
 * Derives a stable externalId from the entry's own content. Every field that distinguishes
 * one posting from another is included, in a fixed order, so two genuinely different entries
 * cannot collide and two identical ones cannot double-post.
 */
export function deterministicExternalId(
  businessId: string,
  details: Omit<MoneyTransactionDetails, 'externalId'>
): string {
  const parts: string[] = [
    // Unlike the entry's own fields, businessId comes from configuration rather than from
    // validateMoneyTransactionDetails, so it is checked here to keep the separator invariant
    // below true of *every* joined value.
    rejectControlCharacters(businessId, 'businessId'),
    details.date,
    details.description,
    details.notes ?? '',
    details.anchor.accountId,
    details.anchor.amount,
    details.anchor.direction,
  ];
  for (const item of details.lineItems) {
    parts.push(
      item.accountId,
      item.amount,
      item.balance,
      item.customerId ?? '',
      item.description ?? ''
    );
    for (const tax of item.taxes ?? []) {
      parts.push(tax.salesTaxId, tax.amount);
    }
  }
  // Unit separator, written as an escape rather than a raw control byte so that an editor,
  // formatter or copy-paste cannot silently turn it into an empty separator. Every value above
  // has been through requireNonEmptyString/optionalString or the businessId check, all of which
  // reject control characters, so no value can contain the separator and the join is unambiguous.
  return uuidV5(parts.join('\u001f'));
}

/**
 * Validates one entry and returns it in the exact shape Wave's MoneyTransactionDetails
 * expects, with an externalId guaranteed to be present.
 *
 * The balance check treats the anchor as the money-account side of the entry: a DEPOSIT
 * debits that account, a WITHDRAWAL credits it. The line items must therefore net to the
 * opposite side by exactly the anchor amount, which permits legitimate splits (for example a
 * deposit of 100.00 recorded as income 110.00 CREDIT plus a fee 10.00 DEBIT). Any taxes on a
 * line post to the same side as that line.
 */
export function validateMoneyTransactionDetails(
  businessId: string,
  raw: any,
  label: string
): ValidatedTransaction {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`${label} must be an object describing the transaction`);
  }

  const date = requireDate(raw.date, `${label}.date`);
  const description = requireNonEmptyString(raw.description, `${label}.description`);
  const notes = optionalString(raw.notes, `${label}.notes`);

  if (!raw.anchor || typeof raw.anchor !== 'object') {
    throw new Error(
      `${label}.anchor is required: the money account the transaction settles against ` +
        `({ accountId, amount, direction })`
    );
  }
  const anchorCents = parseAmountToCents(raw.anchor.amount, `${label}.anchor.amount`);
  const anchor: AnchorInput = {
    accountId: requireNonEmptyString(raw.anchor.accountId, `${label}.anchor.accountId`),
    amount: formatCents(anchorCents),
    direction: requireEnum(raw.anchor.direction, `${label}.anchor.direction`, [
      'DEPOSIT',
      'WITHDRAWAL',
    ] as const),
  };

  if (!Array.isArray(raw.lineItems) || raw.lineItems.length === 0) {
    throw new Error(`${label}.lineItems is required and must contain at least one line item`);
  }

  let lineNetCents = 0; // positive = net CREDIT, negative = net DEBIT
  const lineItems: LineItemInput[] = raw.lineItems.map((rawItem: any, index: number) => {
    const itemLabel = `${label}.lineItems[${index}]`;
    if (!rawItem || typeof rawItem !== 'object') {
      throw new Error(`${itemLabel} must be an object`);
    }

    const amountCents = parseAmountToCents(rawItem.amount, `${itemLabel}.amount`);
    const balance = requireEnum(rawItem.balance, `${itemLabel}.balance`, [
      'DEBIT',
      'CREDIT',
    ] as const);

    const taxes: SalesTaxInput[] | undefined =
      rawItem.taxes === undefined || rawItem.taxes === null
        ? undefined
        : (() => {
            if (!Array.isArray(rawItem.taxes)) {
              throw new Error(`${itemLabel}.taxes must be an array when provided`);
            }
            return rawItem.taxes.map((rawTax: any, taxIndex: number): SalesTaxInput => {
              const taxLabel = `${itemLabel}.taxes[${taxIndex}]`;
              if (!rawTax || typeof rawTax !== 'object') {
                throw new Error(`${taxLabel} must be an object`);
              }
              return {
                salesTaxId: requireNonEmptyString(rawTax.salesTaxId, `${taxLabel}.salesTaxId`),
                amount: formatCents(parseAmountToCents(rawTax.amount, `${taxLabel}.amount`)),
              };
            });
          })();

    const taxCents = (taxes ?? []).reduce(
      (sum, tax) => sum + parseAmountToCents(tax.amount, `${itemLabel}.taxes[].amount`),
      0
    );
    lineNetCents += (balance === 'CREDIT' ? 1 : -1) * (amountCents + taxCents);

    const item: LineItemInput = {
      accountId: requireNonEmptyString(rawItem.accountId, `${itemLabel}.accountId`),
      amount: formatCents(amountCents),
      balance,
    };
    const customerId = optionalString(rawItem.customerId, `${itemLabel}.customerId`);
    if (customerId !== undefined) {
      item.customerId = customerId;
    }
    const itemDescription = optionalString(rawItem.description, `${itemLabel}.description`);
    if (itemDescription !== undefined) {
      item.description = itemDescription;
    }
    if (taxes) {
      item.taxes = taxes;
    }
    return item;
  });

  // A DEPOSIT debits the money account, so the lines must net to a CREDIT of the same size
  // (and the mirror for a WITHDRAWAL). Expressed as a signed sum, a balanced entry is 0.
  const expectedLineNetCents = anchor.direction === 'DEPOSIT' ? anchorCents : -anchorCents;
  const residualCents = lineNetCents - expectedLineNetCents;
  if (residualCents !== 0) {
    throw new Error(
      `${label} does not balance and was NOT sent to Wave. The anchor is a ${anchor.direction} ` +
        `of ${anchor.amount} against account ${anchor.accountId}, so the line items must net to a ` +
        `${anchor.direction === 'DEPOSIT' ? 'CREDIT' : 'DEBIT'} of ${anchor.amount}, but they net ` +
        `to a ${lineNetCents >= 0 ? 'CREDIT' : 'DEBIT'} of ${formatCents(Math.abs(lineNetCents))} ` +
        `(off by ${formatCents(Math.abs(residualCents))}). Line-item taxes count on the same side ` +
        `as their line. Wave money transactions cannot be read back, amended or deleted through ` +
        `the API, so this is rejected before sending rather than left to be fixed by hand in the ` +
        `Wave web UI.`
    );
  }

  const externalIdProvided =
    raw.externalId !== undefined && raw.externalId !== null && raw.externalId !== '';
  const core = { date, description, notes, anchor, lineItems };
  const externalId = externalIdProvided
    ? requireNonEmptyString(raw.externalId, `${label}.externalId`)
    : deterministicExternalId(businessId, core);

  return {
    details: { externalId, ...core },
    externalIdGenerated: !externalIdProvided,
  };
}
