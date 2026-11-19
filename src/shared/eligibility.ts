// Max price eligibility by recipient country, per Meta:
// https://developers.facebook.com/documentation/business-messaging/whatsapp/marketing-messages/pricing
// https://developers.facebook.com/documentation/business-messaging/whatsapp/marketing-messages/get-started

export type EligibilityStatus =
  | 'eligible' // max price applies
  | 'flagged' // no delivery optimization; Meta doesn't say whether max price applies
  | 'no_max_price' // max pricing is not used
  | 'blocked' // messages cannot be sent at all
  | 'not_delivered'; // marketing messages are not delivered

export interface Eligibility {
  status: EligibilityStatus;
  /** Can this country carry a multiplier override? */
  inMap: boolean;
  /** Can a marketing message be sent to this country at all? */
  canSend: boolean;
  note: string;
  errorCode?: number;
}

const NOT_DELIVERED = new Set(['US']);
// Crimea, Donetsk and Luhansk are also blocked, but share Ukraine's +380 code:
// they can't be told apart from a phone number.
const BLOCKED = new Set(['CU', 'IR', 'KP', 'SY', 'VE']);
const NO_MAX_PRICE = new Set(['RU', 'BY']);

const EU = ['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE'];
const EEA = [...EU, 'IS', 'LI', 'NO'];
const NO_DELIVERY_OPTIMIZATION = new Set([...EEA, 'GB', 'JP', 'KR', 'NG', 'ZA', 'TH']);

export function eligibility(iso: string): Eligibility {
  const c = iso.toUpperCase();
  if (NOT_DELIVERED.has(c)) {
    return { status: 'not_delivered', inMap: false, canSend: false, errorCode: 131049, note: 'Meta: marketing messages to US users are not delivered (131049)' };
  }
  if (BLOCKED.has(c)) {
    return { status: 'blocked', inMap: false, canSend: false, note: 'Meta: messages cannot be sent to users in this country' };
  }
  if (NO_MAX_PRICE.has(c)) {
    return { status: 'no_max_price', inMap: false, canSend: true, note: 'Meta: max pricing not used for users in this country' };
  }
  if (NO_DELIVERY_OPTIMIZATION.has(c)) {
    return {
      status: 'flagged',
      inMap: true,
      canSend: true,
      note: "Meta: no delivery optimization here; max price not stated either way. Override kept so the cap equals the rate card if max price applies",
    };
  }
  return { status: 'eligible', inMap: true, canSend: true, note: '' };
}

/** ISO codes Meta says max price can't apply to; never put in the override map. */
export const EXCLUDED_FROM_MAP = [...NOT_DELIVERED, ...BLOCKED, ...NO_MAX_PRICE];
