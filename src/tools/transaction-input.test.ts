/**
 * Tests for money-transaction input validation.
 *
 * These matter more than most: `moneyTransactionCreate` / `moneyTransactionsCreate` are one-way.
 * Wave has no transaction query, update or delete, so nothing written here can be read back or
 * corrected through the API - a malformed or duplicated entry has to be fixed by hand in the Wave
 * web UI. The pre-send checks are therefore the only safety net, and these tests are what keeps
 * them honest.
 *
 * Run with `npm test` (compiles first, then `node --test` over build/).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  validateMoneyTransactionDetails,
  type MoneyTransactionDetails,
} from './transaction-input.js';

const BUSINESS = 'QnVzaW5lc3M6dGVzdA==';

/** A minimal balanced entry: 10.00 out of the bank, 10.00 onto a fee account. */
function feeEntry(overrides: Record<string, unknown> = {}) {
  return {
    date: '2026-09-18',
    description: 'Amazon FBA fee',
    anchor: { accountId: 'acct-bank', amount: '10.00', direction: 'WITHDRAWAL' },
    lineItems: [{ accountId: 'acct-fees', amount: '10.00', balance: 'DEBIT' }],
    ...overrides,
  };
}

const validate = (raw: unknown) => validateMoneyTransactionDetails(BUSINESS, raw, 'transaction');
const detailsOf = (raw: unknown): MoneyTransactionDetails => validate(raw).details;
const externalIdOf = (raw: unknown) => detailsOf(raw).externalId;

test('accepts a balanced single-line entry and normalizes it', () => {
  const details = detailsOf(feeEntry());
  assert.equal(details.anchor.amount, '10.00');
  assert.equal(details.anchor.direction, 'WITHDRAWAL');
  assert.equal(details.lineItems[0].balance, 'DEBIT');
  assert.equal(details.lineItems.length, 1);
});

test('accepts a split deposit that nets to the anchor (income minus a fee)', () => {
  // 110.00 CREDIT - 10.00 DEBIT = 100.00 CREDIT, matching a 100.00 DEPOSIT.
  assert.doesNotThrow(() =>
    validate({
      date: '2026-09-18',
      description: 'Amazon payout',
      anchor: { accountId: 'bank', amount: '100.00', direction: 'DEPOSIT' },
      lineItems: [
        { accountId: 'income', amount: '110.00', balance: 'CREDIT' },
        { accountId: 'fees', amount: '10.00', balance: 'DEBIT' },
      ],
    })
  );
});

test('counts line taxes on the same side as their line item', () => {
  assert.doesNotThrow(() =>
    validate({
      date: '2026-09-18',
      description: 'Supplies with tax',
      anchor: { accountId: 'bank', amount: '11.50', direction: 'WITHDRAWAL' },
      lineItems: [
        {
          accountId: 'expense',
          amount: '10.00',
          balance: 'DEBIT',
          taxes: [{ salesTaxId: 'tax-1', amount: '1.50' }],
        },
      ],
    })
  );
});

test('rejects an entry that does not balance, before anything is sent', () => {
  assert.throws(
    () => validate(feeEntry({ lineItems: [{ accountId: 'f', amount: '9.99', balance: 'DEBIT' }] })),
    /does not balance and was NOT sent/
  );
});

test('rejects the right amount posted to the wrong side', () => {
  // A WITHDRAWAL credits the money account, so the lines must net DEBIT, not CREDIT.
  assert.throws(
    () => validate(feeEntry({ lineItems: [{ accountId: 'f', amount: '10.00', balance: 'CREDIT' }] })),
    /does not balance/
  );
});

test('balances exactly at cent precision (no binary floating point drift)', () => {
  // Amounts chosen so that naive float math is provably off: Number('1.10') * 100 +
  // Number('2.20') * 100 - Number('3.30') * 100 === 5.68e-14, not 0. (0.10/0.20/0.30 would NOT
  // catch this - those three are exactly representable once multiplied by 100, so a float
  // implementation passes them.) This only balances if amounts are parsed to integer cents.
  assert.doesNotThrow(() =>
    validate({
      date: '2026-09-18',
      description: 'Float trap',
      anchor: { accountId: 'bank', amount: '3.30', direction: 'WITHDRAWAL' },
      lineItems: [
        { accountId: 'a', amount: '1.10', balance: 'DEBIT' },
        { accountId: 'b', amount: '2.20', balance: 'DEBIT' },
      ],
    })
  );
  // A second shape, with the drift in the other direction.
  assert.doesNotThrow(() =>
    validate({
      date: '2026-09-18',
      description: 'Float trap 2',
      anchor: { accountId: 'bank', amount: '4.45', direction: 'WITHDRAWAL' },
      lineItems: [
        { accountId: 'a', amount: '4.35', balance: 'DEBIT' },
        { accountId: 'b', amount: '0.10', balance: 'DEBIT' },
      ],
    })
  );
});

test('requires Decimal strings, not numbers', () => {
  assert.throws(
    () => validate(feeEntry({ anchor: { accountId: 'b', amount: 10, direction: 'WITHDRAWAL' } })),
    /Decimal string/
  );
});

test('rejects signed, over-precise and zero amounts', () => {
  const anchor = (amount: unknown) => ({ accountId: 'b', amount, direction: 'WITHDRAWAL' });
  assert.throws(() => validate(feeEntry({ anchor: anchor('-10.00') })), /unsigned/);
  assert.throws(() => validate(feeEntry({ anchor: anchor('10.001') })), /at most 2 decimal/);
  assert.throws(() => validate(feeEntry({ anchor: anchor('0.00') })), /greater than zero/);
});

test('rejects malformed and calendar-impossible dates', () => {
  assert.throws(() => validate(feeEntry({ date: '18/09/2026' })), /YYYY-MM-DD/);
  assert.throws(() => validate(feeEntry({ date: '2026-02-30' })), /not a real calendar date/);
});

test('accepts only DEBIT/CREDIT, since INCREASE/DECREASE cannot be balance-checked', () => {
  assert.throws(
    () => validate(feeEntry({ lineItems: [{ accountId: 'f', amount: '10.00', balance: 'INCREASE' }] })),
    /DEBIT \| CREDIT/
  );
});

test('requires an anchor and at least one line item', () => {
  const { anchor, ...withoutAnchor } = feeEntry();
  assert.throws(() => validate(withoutAnchor), /anchor is required/);
  assert.throws(() => validate(feeEntry({ lineItems: [] })), /at least one line item/);
});

test('normalizes lowercase enums rather than rejecting them', () => {
  const details = detailsOf(
    feeEntry({
      anchor: { accountId: 'b', amount: '10.00', direction: 'withdrawal' },
      lineItems: [{ accountId: 'f', amount: '10.00', balance: 'debit' }],
    })
  );
  assert.equal(details.anchor.direction, 'WITHDRAWAL');
  assert.equal(details.lineItems[0].balance, 'DEBIT');
});

test('rejects control characters, which would corrupt the externalId derivation', () => {
  // The derivation joins fields with U+001F and relies on that byte being absent from the values.
  assert.throws(
    () => validate(feeEntry({ description: 'Amazon\u001ffee' })),
    /must not contain control characters/
  );
  assert.throws(
    () => validate(feeEntry({ notes: 'line one\u0000line two' })),
    /must not contain control characters/
  );
  // businessId comes from configuration, not from the entry, and is the first value joined.
  assert.throws(
    () => validateMoneyTransactionDetails('QnVzaW5\u001flc3M=', feeEntry(), 'transaction'),
    /must not contain control characters/
  );
});

test('derives the same externalId for the same entry, so a re-run cannot double-post', () => {
  const first = validate(feeEntry());
  const second = validate(feeEntry());
  assert.equal(first.details.externalId, second.details.externalId);
  assert.equal(first.externalIdGenerated, true);
  assert.match(
    first.details.externalId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    'must be an RFC 4122 v5 UUID'
  );
});

test('derives a different externalId when the entry genuinely differs', () => {
  const base = externalIdOf(feeEntry());
  const differentAmount = externalIdOf({
    ...feeEntry(),
    anchor: { accountId: 'acct-bank', amount: '11.00', direction: 'WITHDRAWAL' },
    lineItems: [{ accountId: 'acct-fees', amount: '11.00', balance: 'DEBIT' }],
  });
  const differentDate = externalIdOf(feeEntry({ date: '2026-09-17' }));
  const differentDescription = externalIdOf(feeEntry({ description: 'Amazon referral fee' }));
  const differentAccount = externalIdOf({
    ...feeEntry(),
    lineItems: [{ accountId: 'acct-other', amount: '10.00', balance: 'DEBIT' }],
  });
  assert.notEqual(base, differentAmount);
  assert.notEqual(base, differentDate);
  assert.notEqual(base, differentDescription);
  assert.notEqual(base, differentAccount);
});

/**
 * Each of these is a field the balance check does NOT pin: two entries can differ in it alone and
 * both still balance. If such a field were dropped from the derivation, the two would share an
 * externalId and Wave would dedupe the second away - a ledger entry silently missing, on a write
 * that cannot be read back. So every one of them gets its own assertion.
 */
test('every free-standing field feeds the externalId, so a real second entry is never deduped', () => {
  const base = externalIdOf(feeEntry());

  // notes: the only difference between two otherwise identical postings on the same day.
  assert.notEqual(base, externalIdOf(feeEntry({ notes: 'settlement 2026-08' })));
  assert.notEqual(
    externalIdOf(feeEntry({ notes: 'settlement 2026-08' })),
    externalIdOf(feeEntry({ notes: 'settlement 2026-09' }))
  );

  // Line-item description and customerId, which distinguish two identical-amount fee lines.
  const withLine = (extra: Record<string, unknown>) =>
    externalIdOf(
      feeEntry({ lineItems: [{ accountId: 'acct-fees', amount: '10.00', balance: 'DEBIT', ...extra }] })
    );
  assert.notEqual(base, withLine({ description: 'order 111-222' }));
  assert.notEqual(withLine({ description: 'order 111-222' }), withLine({ description: 'order 333-444' }));
  assert.notEqual(base, withLine({ customerId: 'cust-1' }));
  assert.notEqual(withLine({ customerId: 'cust-1' }), withLine({ customerId: 'cust-2' }));

  // Line taxes: same total, different tax code, so the entry still balances either way.
  const taxed = (salesTaxId: string) =>
    externalIdOf({
      date: '2026-09-18',
      description: 'Supplies with tax',
      anchor: { accountId: 'bank', amount: '11.50', direction: 'WITHDRAWAL' },
      lineItems: [
        {
          accountId: 'expense',
          amount: '10.00',
          balance: 'DEBIT',
          taxes: [{ salesTaxId, amount: '1.50' }],
        },
      ],
    });
  assert.notEqual(taxed('tax-state'), taxed('tax-city'));
});

test('scopes the externalId to the business, so the same entry differs across books', () => {
  const fvr = validateMoneyTransactionDetails(BUSINESS, feeEntry(), 't').details.externalId;
  const other = validateMoneyTransactionDetails('QnVzaW5lc3M6b3RoZXI=', feeEntry(), 't').details
    .externalId;
  assert.notEqual(fvr, other);
});

test('cannot collide by shifting text across adjacent fields', () => {
  // Without a separator, description "AB" + notes "C" and "A" + "BC" would hash identically.
  const a = externalIdOf(feeEntry({ description: 'AB', notes: 'C' }));
  const b = externalIdOf(feeEntry({ description: 'A', notes: 'BC' }));
  assert.notEqual(a, b);
});

test('keeps an explicit externalId and flags it as caller-supplied', () => {
  const validated = validate(feeEntry({ externalId: 'amz-settlement-42' }));
  assert.equal(validated.details.externalId, 'amz-settlement-42');
  assert.equal(validated.externalIdGenerated, false);
});

test('treats a blank optional field as absent rather than rejecting the entry', () => {
  // "" is a common fill for an optional field; it must not fail, and must not change the id.
  const blank = validate(feeEntry({ notes: '' }));
  const omitted = validate(feeEntry());
  assert.equal(blank.details.notes, undefined);
  assert.equal(blank.details.externalId, omitted.details.externalId);
});

test('amount spelling does not change the derived externalId', () => {
  // "10.0" and "10.00" are the same posting, so a re-run spelled differently must still dedupe.
  const terse = externalIdOf({
    ...feeEntry(),
    anchor: { accountId: 'acct-bank', amount: '10.0', direction: 'WITHDRAWAL' },
    lineItems: [{ accountId: 'acct-fees', amount: '10.0', balance: 'DEBIT' }],
  });
  assert.equal(terse, externalIdOf(feeEntry()));
});
