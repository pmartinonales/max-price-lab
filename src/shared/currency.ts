// ISO 4217 minor units (number of decimals) for the currencies a WABA can be
// billed in. bid_amount is expressed in the smallest unit of the WABA
// currency, per 1,000 deliveries, so minor units drive the conversion.
export const MINOR_UNITS: Record<string, number> = {
  USD: 2,
  EUR: 2,
  GBP: 2,
  INR: 2,
  IDR: 2,
  BRL: 2,
  MXN: 2,
  AUD: 2,
  CAD: 2,
  NZD: 2,
  HKD: 2,
  SGD: 2,
  MYR: 2,
  PHP: 2,
  THB: 2,
  TWD: 2,
  CHF: 2,
  SEK: 2,
  NOK: 2,
  DKK: 2,
  PLN: 2,
  CZK: 2,
  HUF: 2,
  RON: 2,
  TRY: 2,
  ZAR: 2,
  NGN: 2,
  EGP: 2,
  AED: 2,
  SAR: 2,
  QAR: 2,
  ILS: 2,
  PKR: 2,
  ARS: 2,
  COP: 2,
  PEN: 2,
  JPY: 0,
  KRW: 0,
  CLP: 0,
  VND: 0,
  ISK: 0,
  PYG: 0,
  KWD: 3,
  BHD: 3,
  OMR: 3,
  JOD: 3,
  TND: 3,
};

export function minorUnits(currency: string): number {
  const units = MINOR_UNITS[currency.toUpperCase()];
  if (units === undefined) {
    throw new Error(`Unknown currency "${currency}": add its ISO 4217 minor units to src/shared/currency.ts`);
  }
  return units;
}

// Rates are handled as integers scaled by 10^8 so the maths stays exact.
// Meta's rate cards use at most 4 decimals; 8 leaves plenty of room.
export const RATE_SCALE_DECIMALS = 8;
export const RATE_SCALE = 10n ** BigInt(RATE_SCALE_DECIMALS);

export function toScaled(rate: number): bigint {
  const scaled = rate * 10 ** RATE_SCALE_DECIMALS;
  const rounded = Math.round(scaled);
  if (Math.abs(scaled - rounded) > 1e-4) {
    throw new Error(`Rate ${rate} has more than ${RATE_SCALE_DECIMALS} decimals`);
  }
  return BigInt(rounded);
}
