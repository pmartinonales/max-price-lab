# Contributing

Thanks for helping. Bug reports, fixes, rate cards in other currencies and support for more providers are all welcome.

## Before you start

- For a bug, open an issue with the steps, what you expected and what happened. Paste the API error body from the app if there is one.
- For a new feature or a bigger change, open an issue first so we can agree on the approach before you write the code.
- Small fixes (typos, wording, an obvious bug) can go straight to a pull request.

## Setup

Needs Node.js 20 or newer.

```bash
npm install
npm run dev
```

The app runs at http://localhost:3000. You don't need a 360dialog key or a Meta token to work on most of the code: the tests replace the API with a fake, and nothing in them sends a real message.

## Before you open a pull request

Run all three; CI runs the same checks on every pull request.

```bash
npm run typecheck
```

```bash
npm test
```

```bash
npm run build
```

Then:

- Add or update a test for any change to the calculator, the API client, sending or results.
- Update the README if you change how something works or looks.
- Keep the pull request to one change. Several small pull requests are easier to review than one large one.

## How the code is laid out

- `src/shared/`: the max price calculator, eligibility rules and currency handling. Pure functions, no I/O.
- `src/server/`: the Express app, the API client, the rate card parser, sending and results.
- `src/client/`: the React UI.
- `test/`: Vitest tests.

A few rules keep the app predictable:

- **Every call to 360dialog or Meta goes through `src/server/d360.ts`.** The two providers differ only in auth, base URL and paths; screens and server routes don't know which one is in use.
- **Meta's docs are the source of truth** for max price behaviour. Link the page you relied on in the pull request.
- **No cap may end above the country's rate card.** The calculator rounds multipliers down; keep it that way.
- **Never log or return credentials.** API keys and tokens are masked in every response and error message, and tests check this.

## Secrets and personal data

Never commit API keys, access tokens, real phone numbers or customer data, including in tests, screenshots and issue text. Use made-up numbers such as `+5511999999999`. The local database (`data/app.db`) is git-ignored because it holds your credentials.

If you find a security problem, don't open a public issue: see [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
