/**
 * Award maths (design.md §5.2). Pure function — no I/O, no clocks — so the
 * rules engine and the tests can reason about pay deterministically.
 *
 * Model:
 *  - `workedMinutes` is minutes actually on the clock and working, i.e. the
 *    clock-in → clock-out span minus any unpaid break time the employee did
 *    take (paid breaks count as worked).
 *  - Overtime is minutes beyond `maxOrdinaryMinutesPerDay`, paid at
 *    `overtimeMultiplier` × the ordinary rate.
 *  - The award requires an unpaid break of `unpaidBreakMinutes` once the
 *    employee has worked more than `breakRequiredAfterMinutes`. A shortfall
 *    (`unpaidBreakMinutesOwed`) means the employee worked through the window
 *    they should have been on an unpaid break. That time is already inside
 *    `workedMinutes`, so it is paid ordinary time; the award impact is what the
 *    employer pays extra versus a compliant shift. It becomes payable
 *    compensation through the adjustment flow, not by inflating the ordinary
 *    line here.
 *  - `payImpactCents` is the estimated cost of the breaches: the full ordinary
 *    cost of the missed unpaid break minutes, plus the overtime *premium*
 *    (multiplier − 1) the award adds on overtime minutes. Overtime itself is a
 *    normal outcome, not a violation; the premium is what an approver is asked
 *    to sign off on.
 *
 * Money is integer cents; multipliers are numbers. Every fractional cent is
 * rounded half up (0.5 goes to 1.0), independently per component, before summing.
 */

export interface AwardRuleRates {
  maxOrdinaryMinutesPerDay: number;
  overtimeMultiplier: number;
  unpaidBreakMinutes: number;
  breakRequiredAfterMinutes: number;
}

export interface AwardImpactInput {
  rule: AwardRuleRates;
  workedMinutes: number;
  breakMinutesTaken: number;
  hourlyRateCents: number;
}

export interface AwardImpact {
  ordinaryMinutes: number;
  overtimeMinutes: number;
  unpaidBreakMinutesOwed: number;
  payImpactCents: number;
}

export interface AwardTotals extends AwardImpact {
  totalPayCents: number;
}

/** Half-up rounding for non-negative cents. 75.5 → 76, 75.499… → 75. */
export function roundCentsHalfUp(cents: number): number {
  return Math.floor(cents + 0.5);
}

function unpaidBreakMinutesOwedFor(rule: AwardRuleRates, workedMinutes: number, breakMinutesTaken: number): number {
  if (workedMinutes <= rule.breakRequiredAfterMinutes) return 0;
  return Math.max(0, rule.unpaidBreakMinutes - breakMinutesTaken);
}

export function computeAwardImpact(input: AwardImpactInput): AwardImpact {
  const { rule, workedMinutes, breakMinutesTaken, hourlyRateCents } = input;

  const overtimeMinutes = Math.max(0, workedMinutes - rule.maxOrdinaryMinutesPerDay);
  const ordinaryMinutes = workedMinutes - overtimeMinutes;
  const unpaidBreakMinutesOwed = unpaidBreakMinutesOwedFor(rule, workedMinutes, breakMinutesTaken);

  const missedBreakCents = roundCentsHalfUp((unpaidBreakMinutesOwed * hourlyRateCents) / 60);
  const overtimeBaseCents = roundCentsHalfUp((overtimeMinutes * hourlyRateCents) / 60);
  const overtimePremiumCents =
    roundCentsHalfUp((overtimeMinutes * hourlyRateCents * rule.overtimeMultiplier) / 60) - overtimeBaseCents;

  return {
    ordinaryMinutes,
    overtimeMinutes,
    unpaidBreakMinutesOwed,
    payImpactCents: missedBreakCents + overtimePremiumCents,
  };
}

export function computeAwardTotals(input: AwardImpactInput): AwardTotals {
  const { rule, workedMinutes, breakMinutesTaken, hourlyRateCents } = input;

  const overtimeMinutes = Math.max(0, workedMinutes - rule.maxOrdinaryMinutesPerDay);
  const ordinaryMinutes = workedMinutes - overtimeMinutes;
  const unpaidBreakMinutesOwed = unpaidBreakMinutesOwedFor(rule, workedMinutes, breakMinutesTaken);

  const ordinaryPayCents = roundCentsHalfUp((ordinaryMinutes * hourlyRateCents) / 60);
  const overtimePayCents = roundCentsHalfUp(
    (overtimeMinutes * hourlyRateCents * rule.overtimeMultiplier) / 60,
  );

  return {
    ordinaryMinutes,
    overtimeMinutes,
    unpaidBreakMinutesOwed,
    payImpactCents:
      roundCentsHalfUp((unpaidBreakMinutesOwed * hourlyRateCents) / 60) +
      overtimePayCents -
      roundCentsHalfUp((overtimeMinutes * hourlyRateCents) / 60),
    totalPayCents: ordinaryPayCents + overtimePayCents,
  };
}
