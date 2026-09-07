'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createClient } = require('@supabase/supabase-js');

function readEnv(filePath) {
  if (!fs.existsSync(filePath)) return {};
  return Object.fromEntries(
    fs.readFileSync(filePath, 'utf8')
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#') && line.includes('='))
      .map(line => {
        const splitAt = line.indexOf('=');
        return [line.slice(0, splitAt), line.slice(splitAt + 1)];
      }),
  );
}

const localEnv = readEnv(path.join(__dirname, '.env.local'));
const supabaseUrl = process.env.SUPABASE_URL || localEnv.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || localEnv.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required in .env.local.');
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const MANILA_OFFSET = '+08:00';
const DAY_MS = 86_400_000;

function manilaDateKey(value = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(value);
  const get = type => parts.find(part => part.type === type)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function shiftDate(dateKey, days) {
  return new Date(`${dateKey}T00:00:00${MANILA_OFFSET}`).getTime() + days * DAY_MS;
}

function dateAtOffset(today, days) {
  return manilaDateKey(new Date(shiftDate(today, days)));
}

function timestamp(date, hour, minute = 0) {
  return `${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00${MANILA_OFFSET}`;
}

function formatHour(hour) {
  const normalized = ((hour % 24) + 24) % 24;
  return `${normalized % 12 || 12}:00 ${normalized < 12 ? 'AM' : 'PM'}`;
}

function demoRef(runKey, index) {
  return `DEMO-${runKey.replaceAll('-', '')}-${String(index + 1).padStart(3, '0')}`;
}

function paymentReference(method, runKey, index) {
  const dateDigits = runKey.replaceAll('-', '');
  const sequence = String(index + 1).padStart(3, '0');
  if (method === 'gcash') return `99${dateDigits}${sequence}`;
  if (method === 'maya') return `M${dateDigits}${sequence}`;
  if (method === 'bpi') return `97${dateDigits}${sequence}`;
  return null;
}

function customer(index) {
  const names = [
    'Demo Alex Santos', 'Demo Bea Cruz', 'Demo Carlo Reyes', 'Demo Dana Lim',
    'Demo Eli Garcia', 'Demo Faith Mendoza', 'Demo Gio Ramos', 'Demo Hana Tan',
    'Demo Ivan Flores', 'Demo Julia Navarro', 'Demo Ken Bautista', 'Demo Lara Ong',
  ];
  const number = String(index + 1).padStart(2, '0');
  return {
    full_name: names[index % names.length],
    contact_number: `0917-555-${String(1100 + index)}`,
    email: `demo.player${number}@example.invalid`,
  };
}

function buildBooking(today, runKey, index, spec, courts, bookingFee, feeType) {
  const court = courts[index % courts.length];
  const date = dateAtOffset(today, spec.day);
  const duration = spec.duration || 1;
  const start = spec.start;
  const slots = Array.from({ length: duration }, (_, slotIndex) => start + slotIndex);
  const courtRental = Number(court.rate || 0) * duration;
  const platformFee = bookingFee * duration;
  const total = courtRental + platformFee;
  const guest = customer(index);
  const createdDate = dateAtOffset(today, Math.min(spec.day - 3, -1));
  const paid = spec.paymentStatus === 'paid';
  const partiallyPaid = spec.paymentStatus === 'downpayment_paid';
  const digital = spec.paymentMethod !== 'cash';
  const ledgerEligible = spec.createdVia !== 'import';
  const earned = ledgerEligible && ['confirmed', 'completed'].includes(spec.status)
    && ['paid', 'downpayment_paid'].includes(spec.paymentStatus);

  return {
    ref: demoRef(runKey, index),
    ...guest,
    court_id: court.id,
    court_name: court.name,
    date,
    slots,
    start_time: formatHour(start),
    end_time: formatHour(start + duration),
    duration,
    rate: Number(court.rate || 0),
    total,
    payment_method: spec.paymentMethod,
    received_account: spec.paymentMethod === 'cash' ? 'cash' : spec.paymentMethod,
    payment_flow: digital ? 'manual_receipt' : 'front_desk',
    payment_status: spec.paymentStatus,
    paid_at: paid ? timestamp(spec.day > 0 ? today : date, 9 + (index % 8), 15) : null,
    gcash_ref: digital ? paymentReference(spec.paymentMethod, runKey, index) : null,
    downpayment: partiallyPaid ? Math.ceil(total / 2) : null,
    receipt_status: spec.paymentStatus === 'for_verification'
      ? 'manual_review'
      : digital && paid ? 'auto_approved' : 'none',
    receipt_verified_at: digital && paid ? timestamp(spec.day > 0 ? today : date, 9 + (index % 8), 20) : null,
    booking_fee_rate_snapshot: ledgerEligible ? bookingFee : 0,
    booking_fee_type_snapshot: feeType,
    booking_fee_units_snapshot: feeType === 'flat' ? 1 : duration,
    booking_fee_amount_snapshot: ledgerEligible ? (feeType === 'flat' ? bookingFee : platformFee) : 0,
    booking_fee_snapshot_source: 'seed_demo',
    booking_fee_ledger_eligible_snapshot: ledgerEligible,
    booking_fee_earned_at: earned ? timestamp(spec.day > 0 ? today : date, 9 + (index % 8), 20) : null,
    status: spec.status,
    created_via: spec.createdVia || 'customer',
    created_by_role: spec.createdVia === 'admin' ? 'staff' : null,
    created_by_name: spec.createdVia === 'admin' ? 'Demo Front Desk' : null,
    created_by_email: spec.createdVia === 'admin' ? 'staff@paddlerage.local' : null,
    created_at: timestamp(createdDate, 10 + (index % 7), 5),
  };
}

async function main() {
  const today = manilaDateKey();
  const runKey = today;

  const [{ data: courts, error: courtsError }, { data: settings, error: settingsError }] = await Promise.all([
    supabase.from('courts').select('id,name,rate,blocked').eq('blocked', false).order('id'),
    supabase.from('settings').select('key,value').in('key', ['booking_fee', 'maintenance_fee', 'service_fee_rate', 'fee_type']),
  ]);
  if (courtsError) throw courtsError;
  if (settingsError) throw settingsError;
  if (!courts?.length) throw new Error('No active courts are available for demo bookings.');

  const settingMap = Object.fromEntries((settings || []).map(row => [row.key, row.value]));
  const bookingFee = Number(settingMap.maintenance_fee || settingMap.service_fee_rate || settingMap.booking_fee || 5);
  const feeType = ['flat', 'booking', 'per_booking', 'per_transaction'].includes(String(settingMap.fee_type || '').toLowerCase())
    ? 'flat'
    : 'per_hour';

  const bookingSpecs = [
    { day: -34, start: 7, duration: 2, status: 'completed', paymentStatus: 'paid', paymentMethod: 'gcash' },
    { day: -31, start: 16, duration: 1, status: 'completed', paymentStatus: 'paid', paymentMethod: 'cash', createdVia: 'admin' },
    { day: -27, start: 18, duration: 2, status: 'completed', paymentStatus: 'paid', paymentMethod: 'maya' },
    { day: -22, start: 9, duration: 1, status: 'cancelled', paymentStatus: 'unpaid', paymentMethod: 'cash' },
    { day: -16, start: 19, duration: 2, status: 'completed', paymentStatus: 'paid', paymentMethod: 'bpi' },
    { day: -11, start: 8, duration: 1, status: 'completed', paymentStatus: 'paid', paymentMethod: 'cash', createdVia: 'admin' },
    { day: -7, start: 17, duration: 2, status: 'completed', paymentStatus: 'paid', paymentMethod: 'gcash' },
    { day: -4, start: 14, duration: 1, status: 'completed', paymentStatus: 'paid', paymentMethod: 'cash', createdVia: 'admin' },
    { day: -2, start: 19, duration: 2, status: 'completed', paymentStatus: 'paid', paymentMethod: 'maya' },
    { day: -1, start: 10, duration: 1, status: 'completed', paymentStatus: 'paid', paymentMethod: 'gcash' },
    { day: 0, start: 7, duration: 2, status: 'confirmed', paymentStatus: 'paid', paymentMethod: 'gcash' },
    { day: 0, start: 10, duration: 1, status: 'confirmed', paymentStatus: 'paid', paymentMethod: 'cash', createdVia: 'admin' },
    { day: 0, start: 13, duration: 2, status: 'pending', paymentStatus: 'for_verification', paymentMethod: 'maya' },
    { day: 0, start: 17, duration: 1, status: 'confirmed', paymentStatus: 'downpayment_paid', paymentMethod: 'gcash' },
    { day: 1, start: 8, duration: 2, status: 'confirmed', paymentStatus: 'paid', paymentMethod: 'bpi' },
    { day: 1, start: 18, duration: 2, status: 'confirmed', paymentStatus: 'unpaid', paymentMethod: 'cash', createdVia: 'admin' },
    { day: 2, start: 6, duration: 1, status: 'confirmed', paymentStatus: 'paid', paymentMethod: 'gcash' },
    { day: 2, start: 19, duration: 2, status: 'pending', paymentStatus: 'for_verification', paymentMethod: 'maya' },
    { day: 3, start: 15, duration: 2, status: 'confirmed', paymentStatus: 'downpayment_paid', paymentMethod: 'gcash' },
    { day: 4, start: 9, duration: 1, status: 'confirmed', paymentStatus: 'unpaid', paymentMethod: 'cash', createdVia: 'admin' },
    { day: 5, start: 18, duration: 2, status: 'confirmed', paymentStatus: 'paid', paymentMethod: 'maya' },
    { day: 6, start: 11, duration: 1, status: 'pending', paymentStatus: 'unpaid', paymentMethod: 'cash' },
  ];

  const bookings = bookingSpecs.map((spec, index) => buildBooking(today, runKey, index, spec, courts, bookingFee, feeType));
  const refs = bookings.map(row => row.ref);
  const { data: existingBookings, error: existingError } = await supabase
    .from('bookings').select('ref').in('ref', refs);
  if (existingError) throw existingError;
  const existingRefs = new Set((existingBookings || []).map(row => row.ref));
  const newBookings = bookings.filter(row => !existingRefs.has(row.ref));

  if (newBookings.length) {
    const { error } = await supabase.from('bookings').insert(newBookings);
    if (error) throw error;
  }

  const openPlaySpecs = [
    { day: -8, hour: 18, status: 'paid', method: 'cash' },
    { day: -3, hour: 19, status: 'paid', method: 'gcash' },
    { day: 0, hour: 18, status: 'paid', method: 'cash' },
    { day: 0, hour: 18, status: 'paid', method: 'gcash' },
    { day: 0, hour: 19, status: 'pending', method: 'gcash' },
    { day: 1, hour: 18, status: 'paid', method: 'cash' },
    { day: 1, hour: 19, status: 'pending', method: 'gcash' },
    { day: 3, hour: 18, status: 'pending', method: 'cash' },
  ];
  const openPlayRows = openPlaySpecs.map((spec, index) => {
    const court = courts[index % courts.length];
    const date = dateAtOffset(today, spec.day);
    return {
      full_name: `Demo Open Play ${String(index + 1).padStart(2, '0')}`,
      court_id: court.id,
      court_name: court.name,
      date,
      hour: spec.hour,
      time_label: `${formatHour(spec.hour)} - ${formatHour(spec.hour + 1)}`,
      payment_type: 'Full Payment',
      amount: 100,
      payment_method: spec.method,
      gcash_ref: spec.method === 'gcash' ? `98${runKey.replaceAll('-', '')}${String(index + 1).padStart(3, '0')}` : null,
      payment_status: spec.status,
      receipt_status: spec.method === 'gcash' && spec.status === 'paid' ? 'auto_approved' : 'none',
      receipt_verified_at: spec.method === 'gcash' && spec.status === 'paid' ? timestamp(date, spec.hour - 2, 15) : null,
      created_at: timestamp(dateAtOffset(today, Math.min(spec.day, 0)), 9 + index, 10),
    };
  });

  const { data: existingOpenPlay, error: openPlayReadError } = await supabase
    .from('open_play_registrations')
    .select('full_name')
    .like('full_name', 'Demo Open Play %');
  if (openPlayReadError) throw openPlayReadError;
  const existingOpenPlayNames = new Set((existingOpenPlay || []).map(row => row.full_name));
  const newOpenPlay = openPlayRows.filter(row => !existingOpenPlayNames.has(row.full_name));
  if (newOpenPlay.length) {
    const { error } = await supabase.from('open_play_registrations').insert(newOpenPlay);
    if (error) throw error;
  }

  const [{ count: bookingCount, error: bookingCountError }, { count: openPlayCount, error: openPlayCountError }] = await Promise.all([
    supabase.from('bookings').select('*', { count: 'exact', head: true }).like('ref', 'DEMO-%'),
    supabase.from('open_play_registrations').select('*', { count: 'exact', head: true }).like('full_name', 'Demo Open Play %'),
  ]);
  if (bookingCountError) throw bookingCountError;
  if (openPlayCountError) throw openPlayCountError;

  console.log(`Demo data ready for ${today} (Asia/Manila).`);
  console.log(`Bookings: ${bookingCount} total demo records (${newBookings.length} added).`);
  console.log(`Open Play: ${openPlayCount} total demo records (${newOpenPlay.length} added).`);
}

main().catch(error => {
  console.error(`Demo seed failed: ${error.message}`);
  process.exitCode = 1;
});
