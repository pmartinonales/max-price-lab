import { describe, it, expect } from 'vitest';
import { parseStatuses } from '../src/server/webhook-parse';

const wrap = (status: object) => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      id: 'WABA_ID',
      changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: {}, statuses: [status] } }],
    },
  ],
});

const base = { id: 'wamid.ABC', status: 'delivered', timestamp: '1762876800', recipient_id: '5511999999999' };

describe('webhook status parser', () => {
  it('reads cost under pricing.cost', () => {
    const [e] = parseStatuses(
      wrap({
        ...base,
        pricing: {
          billable: true,
          pricing_model: 'PMP',
          category: 'marketing_lite_dynamic',
          type: 'regular',
          cost: { amount: 0.0431, currency: 'EUR' },
        },
      }),
    );
    expect(e).toMatchObject({
      wamid: 'wamid.ABC',
      status: 'delivered',
      recipientId: '5511999999999',
      timestamp: 1762876800,
      billable: true,
      pricingModel: 'PMP',
      category: 'marketing_lite_dynamic',
      pricingType: 'regular',
      costAmount: 0.0431,
      costCurrency: 'EUR',
    });
  });

  it('reads cost at the top level of the status', () => {
    const [e] = parseStatuses(
      wrap({
        ...base,
        pricing: { billable: true, pricing_model: 'PMP', category: 'marketing_lite' },
        cost: { amount: '0.0518', currency: 'EUR' },
      }),
    );
    expect(e.costAmount).toBe(0.0518);
    expect(e.costCurrency).toBe('EUR');
    expect(e.category).toBe('marketing_lite');
  });

  it('handles a status with no pricing at all', () => {
    const [e] = parseStatuses(wrap({ ...base, status: 'read' }));
    expect(e).toMatchObject({
      wamid: 'wamid.ABC',
      status: 'read',
      billable: null,
      pricingModel: null,
      category: null,
      costAmount: null,
      costCurrency: null,
    });
  });

  it('keeps error codes on failed statuses', () => {
    const [e] = parseStatuses(
      wrap({ ...base, status: 'failed', errors: [{ code: 131065, title: 'Max price not available' }] }),
    );
    expect(e.errors).toEqual([{ code: 131065, title: 'Max price not available', message: null }]);
  });

  it('ignores payloads without statuses', () => {
    expect(parseStatuses({ entry: [{ changes: [{ value: { messages: [{}] } }] }] })).toEqual([]);
    expect(parseStatuses(null)).toEqual([]);
    expect(parseStatuses('nope')).toEqual([]);
  });
});
