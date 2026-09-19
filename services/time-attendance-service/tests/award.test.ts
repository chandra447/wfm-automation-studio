import { describe, expect, test } from 'bun:test';
import { computeAwardImpact, computeAwardTotals, roundCentsHalfUp } from '../src/domain/award.ts';

const rule = {
  maxOrdinaryMinutesPerDay: 480,
  overtimeMultiplier: 1.5,
  unpaidBreakMinutes: 30,
  breakRequiredAfterMinutes: 300,
};
const rate = 6200;

describe('computeAwardImpact', () => {
  test('a compliant shift owes nothing', () => {
    const impact = computeAwardImpact({ rule, workedMinutes: 420, breakMinutesTaken: 30, hourlyRateCents: rate });
    expect(impact).toEqual({ ordinaryMinutes: 420, overtimeMinutes: 0, unpaidBreakMinutesOwed: 0, payImpactCents: 0 });
  });

  test('a short shift requires no break even if none was taken', () => {
    const impact = computeAwardImpact({ rule, workedMinutes: 240, breakMinutesTaken: 0, hourlyRateCents: rate });
    expect(impact.unpaidBreakMinutesOwed).toBe(0);
    expect(impact.payImpactCents).toBe(0);
  });

  test('a missed unpaid break becomes paid ordinary time with its cost as the impact', () => {
    const impact = computeAwardImpact({ rule, workedMinutes: 480, breakMinutesTaken: 0, hourlyRateCents: rate });
    expect(impact.ordinaryMinutes).toBe(480);
    expect(impact.overtimeMinutes).toBe(0);
    expect(impact.unpaidBreakMinutesOwed).toBe(30);
    expect(impact.payImpactCents).toBe(roundCentsHalfUp((30 * rate) / 60));
  });

  test('overtime beyond the ordinary cap is paid at the multiplier and only the premium is impact', () => {
    const impact = computeAwardImpact({ rule, workedMinutes: 600, breakMinutesTaken: 30, hourlyRateCents: rate });
    expect(impact).toEqual({ ordinaryMinutes: 480, overtimeMinutes: 120, unpaidBreakMinutesOwed: 0, payImpactCents: 6200 });
  });

  test('a missed break and overtime compound into one impact', () => {
    const impact = computeAwardImpact({ rule, workedMinutes: 540, breakMinutesTaken: 0, hourlyRateCents: rate });
    expect(impact.ordinaryMinutes).toBe(480);
    expect(impact.overtimeMinutes).toBe(60);
    expect(impact.unpaidBreakMinutesOwed).toBe(30);
    const missedBreakCents = roundCentsHalfUp((30 * rate) / 60);
    const overtimePremiumCents =
      roundCentsHalfUp((60 * rate * 1.5) / 60) - roundCentsHalfUp((60 * rate) / 60);
    expect(impact.payImpactCents).toBe(missedBreakCents + overtimePremiumCents);
  });

  test('fractional cents round half up, not to even', () => {
    expect(roundCentsHalfUp(75.5)).toBe(76);
    expect(roundCentsHalfUp(76.5)).toBe(77);
    expect(roundCentsHalfUp(75.499)).toBe(75);
    expect(roundCentsHalfUp((1 * 6150) / 60)).toBe(103);
  });

  test('totals split pay between ordinary and overtime lines', () => {
    const totals = computeAwardTotals({ rule, workedMinutes: 600, breakMinutesTaken: 30, hourlyRateCents: rate });
    expect(totals.totalPayCents).toBe(49_600 + 18_600);
    expect(totals.payImpactCents).toBe(0);
  });

  test('totals keep the missed-break minutes inside ordinary pay', () => {
    const totals = computeAwardTotals({ rule, workedMinutes: 540, breakMinutesTaken: 0, hourlyRateCents: rate });
    expect(totals.ordinaryMinutes).toBe(480);
    expect(totals.totalPayCents).toBe(49_600 + 9_300);
    expect(totals.payImpactCents).toBe(3_100 + 3_100);
  });
});
