// src/money.js — shared money rounding + comparison.
// Money is dollars-as-float in memory, exact NUMERIC(12,2) in the DB.
// These helpers keep in-memory rounding consistent everywhere.

// Round to whole cents, avoiding float artifacts (e.g. 1.005 → 1.01).
function roundMoney(x) {
  return Math.round((Number(x) + Number.EPSILON) * 100) / 100;
}

// True if two money amounts are equal to the cent (tolerant of float noise).
function moneyEqual(a, b) {
  return Math.abs(Number(a) - Number(b)) < 0.005;
}

// True if a money delta is non-negligible (>= half a cent).
function moneyNonZero(x) {
  return Math.abs(Number(x)) >= 0.005;
}

module.exports = { roundMoney, moneyEqual, moneyNonZero };
