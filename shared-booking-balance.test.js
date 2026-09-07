const assert = require('node:assert/strict');
const test = require('node:test');
const balance = require('./booking-balance.js');

test('cancelled bookings release their slot', () => {
  assert.equal(balance.holdsSlot({ status: 'pending_payment' }), true);
  assert.equal(balance.holdsSlot({ status: 'confirmed' }), true);
  assert.equal(balance.holdsSlot({ status: 'cancelled' }), false);
});

test('paid amount uses the immutable total for fully paid bookings', () => {
  const booking = { paymentStatus: 'paid', total: 930 };
  assert.equal(balance.paidAmount(booking), 930);
  assert.equal(balance.balanceAmount(booking), 0);
});

test('unpaid bookings do not count as collected revenue', () => {
  const booking = { paymentStatus: 'unpaid', total: 930 };
  assert.equal(balance.paidAmount(booking), 0);
  assert.equal(balance.balanceAmount(booking), 930);
});

test('an accepted short payment counts only the recorded amount', () => {
  const booking = { paymentStatus: 'downpayment_paid', total: 930, downpayment: 700 };
  assert.equal(balance.paidAmount(booking), 700);
  assert.equal(balance.balanceAmount(booking), 230);
});

test('court revenue splits a grouped booking into its actual courts', () => {
  const transactions = [{
    status: 'confirmed',
    total: 930,
    courtName: 'Court 1, Court 2, Court 3',
    items: [
      { courtName: 'Court 1', total: 310, paymentStatus: 'paid' },
      { courtName: 'Court 2', total: 310, paymentStatus: 'paid' },
      { courtName: 'Court 3', total: 310, paymentStatus: 'paid' },
    ],
  }];

  assert.deepEqual(balance.courtRevenueBreakdown(transactions), [
    ['Court 1', 310],
    ['Court 2', 310],
    ['Court 3', 310],
  ]);
});

test('court revenue preserves independent court totals', () => {
  const transactions = [
    { status: 'confirmed', courtName: 'Court A', total: 400, paymentStatus: 'paid' },
    { status: 'confirmed', courtName: 'Court B', total: 600, paymentStatus: 'paid' },
  ];

  assert.deepEqual(balance.courtRevenueBreakdown(transactions), [
    ['Court B', 600],
    ['Court A', 400],
  ]);
});
