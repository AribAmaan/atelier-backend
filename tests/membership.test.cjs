const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeMembershipTier } = require('../dist/lib/providers/engines');
const { membershipAmountInPaise, isMembershipTierId } = require('../dist/lib/payments/razorpay');

test('only two membership tiers exist: free and plus', () => {
  assert.equal(normalizeMembershipTier('free'), 'free');
  assert.equal(normalizeMembershipTier('plus'), 'plus');
});

test('accounts stored as ultra or supreme keep paid access as plus', () => {
  assert.equal(normalizeMembershipTier('ultra'), 'plus');
  assert.equal(normalizeMembershipTier('supreme'), 'plus');
});

test('missing or unknown tier values are free, never paid', () => {
  for (const value of [undefined, null, '', 'PLUS', 'premium', 'admin', 7, {}]) {
    assert.equal(normalizeMembershipTier(value), 'free', String(value));
  }
});

test('new checkouts accept only the plus plan', () => {
  assert.equal(isMembershipTierId('plus'), true);
  for (const value of ['ultra', 'supreme', 'free', undefined, null, 'Plus']) assert.equal(isMembershipTierId(value), false, String(value));
});

test('plus is a single price per billing cycle', () => {
  assert.equal(membershipAmountInPaise('plus', 'monthly'), 20000);
  assert.equal(membershipAmountInPaise('plus', 'quarterly'), Math.round(20000 * 2.85));
  assert.equal(membershipAmountInPaise('plus', 'yearly'), 200000);
});
