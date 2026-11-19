# Max Price Lab

A local demo app for Meta's **max price** on WhatsApp marketing messages, through **360dialog** or straight to **Meta's Cloud API**.

It sets a template's max price equal to each country's official rate card, so you never pay more than the rate card and often pay less. One template covers every country: `bid_amount` is Meta's "Other" rate, and `bid_country_multiplier_overrides` brings every other country's cap down or up to exactly its own rate.

Demo only: no auth, single user, no currency conversion.

## Setup

Needs Node.js 20+.

```bash
npm install
npm run dev
```

Open http://localhost:3000. The UI, the API and the webhook all run on port 3000.

Put Meta's rate card in `data/`. It has a `.csv` name but is an Excel file; either format works. The EUR rate card used to build this app is `data/meta-rate-card-eur.csv`.

## Provider

Pick one in **Settings**. Only the connection changes; every screen works the same with either.

| | 360dialog | Meta Cloud API |
|---|---|---|
| Credentials | API key (`D360-API-KEY`) | System user access token, WABA ID, phone number ID, Graph API version (default v27.0) |
| Base URL | `https://waba-v2.360dialog.io` | `https://graph.facebook.com/<version>` |
| Templates | `/message_templates` | `/{WABA_ID}/message_templates`, and `/{TEMPLATE_ID}` to update one |
| Send | `/marketing_messages` | `/{PHONE_NUMBER_ID}/marketing_messages` |
| Webhook | `POST /v1/configs/webhook` | `POST /{WABA_ID}/subscribed_apps` with `override_callback_uri` |

Each provider keeps its own saved credentials, so you can switch back and forth.

For Meta Cloud API:

- The token needs `whatsapp_business_management` and `whatsapp_business_messaging`. A system user token doesn't expire; a temporary token from the App Dashboard lasts about a day.
- The WABA must be onboarded to the Marketing Messages API and enrolled in max price.
- Your app must already be subscribed to the WABA for the webhook override to work.
- When you click **Register webhook**, Meta first checks the URL with a GET carrying the verify token shown in Settings, and the app answers it. You can also paste the URL and that token as the callback in the App Dashboard instead.

## Tunnel for webhooks

360dialog or Meta needs a public HTTPS URL to send status updates to:

```bash
ngrok http 3000
```

Copy the `https://….ngrok-free.app` URL and paste it in Settings. On ngrok's free plan the URL changes every time you restart ngrok, so paste the new one and click **Register webhook** again. `cloudflared tunnel --url http://localhost:3000` works too.

## Walkthrough

1. **Settings**
   1. Pick the provider. Paste your 360dialog API key, or your Meta access token, WABA ID and phone number ID. Keys and tokens are stored in `data/app.db` and only ever shown masked.
   2. Set the WABA currency.
   3. Paste the tunnel URL and click **Register webhook**. `/webhook` is added if it's missing.
   4. Click **Test connection**.
2. **Rate card:** import Meta's file from `data/`, or upload it. Check that every market maps to countries.
3. **Max price:** choose **Every country** (the default) or pick countries. The table shows each country's multiplier and its cap ÷ rate card, which is never above 100%. The `optimization_spec` JSON has a Copy button.
4. **Templates:** sync your marketing templates. Then, for each template, you can:
   - apply the max price to an approved template (no re-review)
   - reset it to rate card
   - create a new template with or without max price
   - create an A/B pair
5. **Send:**
   1. Pick a template or an A/B pair and fill in its variables.
   2. Paste numbers, one per line. **Check numbers** shows each number's country and eligibility.
   3. Run a dry run first, then send.
6. **Results:** the charged cost per delivered message, against the rate card, by arm, template and country. Use **Export CSV** to download it.
7. **Webhook log:** the raw payloads, searchable by wamid.

## Running the A/B test

1. On **Max price**, keep **Every country**.
2. On **Templates**, click **Create A/B pair** on an approved marketing template that has no max price. That template becomes **arm A**, the rate card arm, and stays unchanged. A copy with the max price becomes **arm B**.
   - The app first tries Meta's duplicate call (`source_template_id`). The copy is approved at once.
   - If the API doesn't accept that call, the app creates arm B as a new template with the same content, and shows why. Arm B then needs Meta approval before you can send it.
3. On **Send**, pick the pair. Recipients are split 50/50 at random, balanced per country, so both arms reach the same mix of countries.
4. On **Results**, pick the pair. Compare **delivery rate**, **average cost per delivered message** and **saving vs rate card** for each arm. **"Delivered with max price applied"** counts deliveries billed as `marketing_lite_dynamic`, which proves max price was used. `marketing_lite` means rate card.

The webhook cost can differ slightly from the invoice; the invoice is final. Max price changes can take up to 1 hour to reach delivery.

## How the max price is calculated

- `bid_amount = floor(Other rate × 10^minor units × 1000)`. For EUR 0.05: `5000`.
- For each country, `multiplier = rate / base`, rounded down to 4 decimals, so `bid_amount × multiplier ≤ rate card`.
- These countries stay out of the map:
  - countries at exactly 1.0
  - US: marketing messages aren't delivered
  - Cuba, Iran, North Korea, Syria, Venezuela: messages can't be sent
  - Russia, Belarus: max pricing isn't used
- The EEA, UK, Japan, South Korea, Nigeria, South Africa and Thailand get no delivery optimization, and Meta doesn't say whether max price applies there. They stay in the map, capped at the rate card, and are flagged.
- A territory that shares a calling code with a named market may be billed as either. It's capped at the lower of the two rates.
- The rate card currency must match the WABA currency. The app never converts currencies.

The full EUR result matches `data/optimization_spec_eur.json`: `bid_amount` 5000 and 159 overrides. You can also print it from the command line:

```bash
npm run calc
```

```bash
npm run calc -- --countries BR,IN,MX --json
```

## Rules this app follows

Meta's docs are the source of truth:

- [Max price](https://developers.facebook.com/documentation/business-messaging/whatsapp/marketing-messages/pricing)
- [Duplicate templates](https://developers.facebook.com/documentation/business-messaging/whatsapp/marketing-messages/pricing/duplicate-templates)
- [Country calling codes](https://developers.facebook.com/docs/whatsapp/pricing#country-calling-codes)

360dialog's own API reference disagrees in two places. It says a template created without a max price can never get one, and that a max price can't be removed. Meta documents both switches for accounts enrolled in max price, so the app follows Meta and shows 360dialog's error body if it refuses.

All API calls, for both providers, are in `src/server/d360.ts`. Messages go to the `marketing_messages` endpoint, because `/messages` rejects max price templates with error 131061.

## Development

```bash
npm test
```

```bash
npm run typecheck
```

```bash
npm run build:market-map
```

`npm run build:market-map` regenerates `src/data/market-to-iso.ts` from the reference workbook.

Layout:

- `src/shared/`: calculator, eligibility, currency
- `src/server/`: Express app, API client (360dialog and Meta Cloud API), rate card parser, send and results
- `src/client/`: React UI
- `test/`: Vitest
- `data/app.db`: local SQLite database (git-ignored)

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) for setup, checks and the rules the code follows. Report security problems privately, as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
