# @crifine/x402

A `fetch` wrapper that handles `402 Payment Required`: pay per request in USDC,
no account, no API key.

```bash
npm install @crifine/x402
```

Works with **any** API that speaks x402 — it has no dependency on the rest of
Crifine.

---

## The one thing to know before using it

This library spends money automatically, on behalf of a program that may run
unattended for hours. Every design choice follows from that:

- **`maxPerCall` is required and has no default.** There is deliberately no
  code path in which this wrapper pays an amount you did not bound.
- **It never holds a key.** Settlement is a callback you supply.
- **It pays at most once per request.** A server that keeps returning 402 gets
  the second response handed back to you, not a second payment — paying into a
  loop is how an unattended agent empties a wallet.
- **Refusals are typed**, so an agent can tell "too expensive" apart from "the
  server is broken".

## Use

```ts
import { x402Fetch } from "@crifine/x402";

const pay = x402Fetch({
  maxPerCall: 0.01,              // required
  maxTotal: 5,                   // optional lifetime budget for this wrapper
  allowHosts: ["api.crifine.app"],
  onPayment: (event) => log(event),   // audit trail
  settle: async ({ amount, currency, network, recipient }) => {
    const proof = await yourWallet.pay({ amount, currency, network, recipient });
    return { proof, amount, currency, network };
  },
});

const response = await pay(
  "https://api.crifine.app/v1/exit/aave-v3-weth?size_usd=5000000",
);

pay.spent;     // running total, in the quoted currency
pay.payments;  // how many settlements happened
```

## With the Crifine SDK

```ts
import { CrifineClient } from "@crifine/sdk";
import { x402Fetch } from "@crifine/x402";

const crifine = new CrifineClient({
  fetch: x402Fetch({ maxPerCall: 0.01, settle }),
});

await crifine.exit("aave-v3-weth", 5_000_000);
```

Free endpoints — evidence, the fragility board — never trigger settlement,
because they never return 402.

## A reference settler, if you want one

```ts
import { x402Fetch, usdcSettler } from "@crifine/x402";
import { createWalletClient, http } from "viem";
import { base } from "viem/chains";

const pay = x402Fetch({
  maxPerCall: 0.01,
  settle: usdcSettler({ walletClient: createWalletClient({ account, chain: base, transport: http() }) }),
});
```

`viem` is an **optional** peer and is imported dynamically — bring your own
settlement (a custodial API, a session key, a paymaster) and you never install
it.

The settler refuses rather than guesses: an unknown network, a missing
recipient, or a currency other than USDC all throw before anything moves. It
converts amounts through strings, so `0.004` never becomes `0.004000000000001`.

## Errors

| Error | Meaning | What an agent should do |
|---|---|---|
| `SpendLimitError` | Quote above `maxPerCall` | Skip the call, or widen the limit deliberately |
| `BudgetExhaustedError` | `maxTotal` reached | Stop; the budget is a decision, not a hiccup |
| `HostNotAllowedError` | 402 from a host outside `allowHosts` | Treat as hostile — something redirected you |
| `MalformedTermsError` | 402 without readable terms | The server is broken; do not pay |

Nothing is spent when any of these throw — the ledger only moves on a receipt.

## The protocol

```http
GET /v1/exit/aave-v3-weth?size_usd=5000000

402 Payment Required
X-Payment-Amount: 0.004
X-Payment-Currency: USDC
X-Payment-Network: base
X-Payment-Recipient: 0x…

# you settle, then the wrapper retries with:
X-Payment-Proof: 0x…

200 OK
```

## Status

The wrapper, its limits and its error handling are **live and tested**. Crifine's
own x402 settlement is **not serving yet** — the contract above is published so
you can build against it. See the
[changelog](https://crifine-docs.crifine.workers.dev/changelog).

## Development

```bash
pnpm install
pnpm test    # 18 tests, most of them about what it refuses to do
```

MIT.
