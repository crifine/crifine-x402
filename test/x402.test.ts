import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BudgetExhaustedError,
  HostNotAllowedError,
  MalformedTermsError,
  SpendLimitError,
  X402Error,
  readTerms,
  x402Fetch,
} from "../src/index.js";
import type { PaymentRequest } from "../src/index.js";

const terms = (amount: number, extra: Record<string, string> = {}) =>
  new Response("payment required", {
    status: 402,
    headers: {
      "x-payment-amount": String(amount),
      "x-payment-currency": "USDC",
      "x-payment-network": "base",
      ...extra,
    },
  });

const settle = async (request: PaymentRequest) => ({
  proof: "0xproof",
  amount: request.amount,
  currency: request.currency,
  network: request.network,
});

/** A fetch that 402s once, then succeeds if proof is attached. */
function payingServer() {
  const calls: (string | null)[] = [];
  const doFetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const proof = new Headers(init?.headers).get("x-payment-proof");
    calls.push(proof);
    return proof ? Response.json({ ok: true }) : terms(0.004);
  };
  return { doFetch: doFetch as typeof fetch, calls };
}

/* ── The refusals. These are the reason the package exists. ─────────────── */

test("a wrapper without maxPerCall cannot be constructed", () => {
  // @ts-expect-error deliberately omitting the required limit
  assert.throws(() => x402Fetch({ settle }), X402Error);
  assert.throws(() => x402Fetch({ maxPerCall: 0, settle }), X402Error);
  assert.throws(() => x402Fetch({ maxPerCall: -1, settle }), X402Error);
});

test("a price above maxPerCall is refused, and nothing is spent", async () => {
  const server = payingServer();
  const pay = x402Fetch({ maxPerCall: 0.001, settle, fetch: server.doFetch });

  await assert.rejects(() => pay("https://api.example.com/x"), SpendLimitError);
  assert.equal(pay.spent, 0);
  assert.equal(pay.payments, 0);
  // Only the first, unpaid attempt happened — no retry, no settlement.
  assert.equal(server.calls.length, 1);
});

test("the cumulative budget stops further spending", async () => {
  const server = payingServer();
  const pay = x402Fetch({ maxPerCall: 1, maxTotal: 0.005, settle, fetch: server.doFetch });

  await pay("https://api.example.com/a");
  assert.equal(pay.spent, 0.004);

  await assert.rejects(() => pay("https://api.example.com/b"), BudgetExhaustedError);
  assert.equal(pay.spent, 0.004, "a refused call must not move the ledger");
});

test("a host outside allowHosts is refused before the terms matter", async () => {
  const server = payingServer();
  const pay = x402Fetch({
    maxPerCall: 1,
    allowHosts: ["api.crifine.app"],
    settle,
    fetch: server.doFetch,
  });

  await assert.rejects(() => pay("https://evil.example.com/x"), HostNotAllowedError);
  assert.equal(pay.spent, 0);
});

test("malformed terms are refused rather than paid just in case", async () => {
  for (const bad of [
    new Response("", { status: 402 }),
    new Response("", { status: 402, headers: { "x-payment-amount": "0" } }),
    new Response("", { status: 402, headers: { "x-payment-amount": "nonsense", "x-payment-currency": "USDC" } }),
    new Response("", { status: 402, headers: { "x-payment-amount": "0.01", "x-payment-currency": "USDC" } }),
  ]) {
    const pay = x402Fetch({
      maxPerCall: 1,
      settle,
      fetch: (async () => bad.clone()) as typeof fetch,
    });
    await assert.rejects(() => pay("https://api.example.com/x"), MalformedTermsError);
    assert.equal(pay.spent, 0);
  }
});

test("a server that keeps asking is not paid twice", async () => {
  let attempts = 0;
  const pay = x402Fetch({
    maxPerCall: 1,
    settle,
    fetch: (async () => {
      attempts += 1;
      return terms(0.004); // never satisfied
    }) as typeof fetch,
  });

  const response = await pay("https://api.example.com/x");
  assert.equal(response.status, 402, "the second 402 is handed back, not paid");
  assert.equal(pay.payments, 1);
  assert.equal(attempts, 2);
});

/* ── The happy path ─────────────────────────────────────────────────────── */

test("402 becomes 200 with proof attached", async () => {
  const server = payingServer();
  const pay = x402Fetch({ maxPerCall: 0.01, settle, fetch: server.doFetch });

  const response = await pay("https://api.example.com/x");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.deepEqual(server.calls, [null, "0xproof"]);
  assert.equal(pay.spent, 0.004);
  assert.equal(pay.payments, 1);
});

test("a non-402 response is passed through untouched", async () => {
  let settled = false;
  const pay = x402Fetch({
    maxPerCall: 1,
    settle: async (r) => {
      settled = true;
      return settle(r);
    },
    fetch: (async () => Response.json({ free: true })) as typeof fetch,
  });

  assert.deepEqual(await (await pay("https://api.example.com/free")).json(), { free: true });
  assert.equal(settled, false, "free endpoints must never trigger settlement");
});

test("without a settle callback a 402 is returned rather than swallowed", async () => {
  const pay = x402Fetch({ maxPerCall: 1, fetch: (async () => terms(0.004)) as typeof fetch });
  assert.equal((await pay("https://api.example.com/x")).status, 402);
});

test("the ledger follows the receipt, not the quote", async () => {
  const server = payingServer();
  const pay = x402Fetch({
    maxPerCall: 1,
    // Settlement came back cheaper than quoted; the ledger must reflect reality.
    settle: async (r) => ({ ...(await settle(r)), amount: 0.002 }),
    fetch: server.doFetch,
  });

  await pay("https://api.example.com/x");
  assert.equal(pay.spent, 0.002);
});

test("onPayment gets an auditable record", async () => {
  const server = payingServer();
  const seen: unknown[] = [];
  const pay = x402Fetch({
    maxPerCall: 0.01,
    settle,
    onPayment: (event) => seen.push(event),
    fetch: server.doFetch,
  });

  await pay("https://api.example.com/x");
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], {
    url: "https://api.example.com/x",
    request: { amount: 0.004, currency: "USDC", network: "base" },
    receipt: { proof: "0xproof", amount: 0.004, currency: "USDC", network: "base" },
    spentTotal: 0.004,
  });
});

test("readTerms picks up the optional fields", () => {
  const parsed = readTerms(
    terms(0.5, { "x-payment-recipient": "0xabc", "x-payment-nonce": "n1" }),
  );
  assert.deepEqual(parsed, {
    amount: 0.5,
    currency: "USDC",
    network: "base",
    recipient: "0xabc",
    nonce: "n1",
  });
});

/* ── The reference settler ──────────────────────────────────────────────── */

test("base units convert without floating-point drift", async () => {
  const { toBaseUnits } = await import("../src/settlers.js");
  assert.equal(toBaseUnits(0.004), 4_000n);
  assert.equal(toBaseUnits(1), 1_000_000n);
  assert.equal(toBaseUnits(0.000001), 1n);
  // 0.1 + 0.2 territory: the naive `amount * 1e6` gives 4000.000000000001 here.
  assert.equal(toBaseUnits(0.0040000000000000001), 4_000n);
});

test("a non-positive amount is refused before any transfer", async () => {
  const { toBaseUnits } = await import("../src/settlers.js");
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => toBaseUnits(bad), X402Error);
  }
});

test("the settler refuses a currency it does not handle", async () => {
  const { usdcSettler } = await import("../src/settlers.js");
  const settle = usdcSettler({ walletClient: {} });

  await assert.rejects(
    () => settle({ amount: 1, currency: "DAI", network: "base", recipient: "0xabc" }),
    /only handles USDC/,
  );
});

test("the settler refuses an unknown network rather than guessing an address", async () => {
  const { usdcSettler } = await import("../src/settlers.js");
  const settle = usdcSettler({ walletClient: {} });

  await assert.rejects(
    () => settle({ amount: 1, currency: "USDC", network: "some-l2", recipient: "0xabc" }),
    /no USDC address known/,
  );
});

test("the settler refuses to send funds nowhere", async () => {
  const { usdcSettler } = await import("../src/settlers.js");
  const settle = usdcSettler({ walletClient: {} });

  await assert.rejects(
    () => settle({ amount: 1, currency: "USDC", network: "base" }),
    /no recipient/,
  );
});

test("the settler transfers the right amount to the right token and returns the hash", async () => {
  const { usdcSettler, USDC } = await import("../src/settlers.js");
  let seen: Record<string, unknown> | undefined;

  const settle = usdcSettler({
    waitForReceipt: false,
    walletClient: {
      account: "0xme",
      chain: { id: 8453 },
      writeContract: async (args: Record<string, unknown>) => {
        seen = args;
        return "0xhash" as const;
      },
    },
  });

  const receipt = await settle({
    amount: 0.004,
    currency: "USDC",
    network: "base",
    recipient: "0xrecipient",
  });

  assert.equal(receipt.proof, "0xhash");
  assert.equal(receipt.amount, 0.004);
  assert.equal(seen?.["address"], USDC["base"]);
  assert.deepEqual(seen?.["args"], ["0xrecipient", 4_000n]);
});

/* ── Concurrency: the failure a counter would miss ──────────────────────── */

test("parallel calls cannot both slip past the same budget", async () => {
  // Both requests read the budget at the same moment. Without a gate around
  // the check-and-spend, each sees 0 spent, each is allowed, and the pair
  // exceeds a limit neither of them individually broke.
  let settling = 0;
  let maxConcurrent = 0;

  const pay = x402Fetch({
    maxPerCall: 1,
    maxTotal: 0.005,
    settle: async (request) => {
      settling += 1;
      maxConcurrent = Math.max(maxConcurrent, settling);
      await new Promise((resolve) => setTimeout(resolve, 5));
      settling -= 1;
      return { proof: "0x", amount: request.amount, currency: request.currency, network: request.network };
    },
    fetch: (async (_input: unknown, init?: RequestInit) => {
      const proof = new Headers(init?.headers).get("x-payment-proof");
      return proof ? Response.json({ ok: true }) : terms(0.004);
    }) as typeof fetch,
  });

  const results = await Promise.allSettled([
    pay("https://api.example.com/a"),
    pay("https://api.example.com/b"),
  ]);

  assert.equal(maxConcurrent, 1, "settlements must not overlap by default");
  assert.equal(pay.spent, 0.004, "only one payment fits the budget");
  assert.equal(
    results.filter((r) => r.status === "rejected").length,
    1,
    "the second must be refused, not quietly allowed",
  );
});

test("concurrency can be raised deliberately", async () => {
  let settling = 0;
  let maxConcurrent = 0;

  const pay = x402Fetch({
    maxPerCall: 1,
    concurrency: 3,
    settle: async (request) => {
      settling += 1;
      maxConcurrent = Math.max(maxConcurrent, settling);
      await new Promise((resolve) => setTimeout(resolve, 5));
      settling -= 1;
      return { proof: "0x", amount: request.amount, currency: request.currency, network: request.network };
    },
    fetch: (async (_input: unknown, init?: RequestInit) => {
      const proof = new Headers(init?.headers).get("x-payment-proof");
      return proof ? Response.json({ ok: true }) : terms(0.001);
    }) as typeof fetch,
  });

  await Promise.all([1, 2, 3].map((n) => pay(`https://api.example.com/${n}`)));
  assert.ok(maxConcurrent > 1, "raising concurrency must actually allow overlap");
  assert.equal(pay.payments, 3);
});

/* ── The ledger ─────────────────────────────────────────────────────────── */

test("receipts accumulate in order and remaining tracks the budget", async () => {
  const server = payingServer();
  const pay = x402Fetch({ maxPerCall: 1, maxTotal: 1, settle, fetch: server.doFetch });

  assert.equal(pay.remaining, 1);
  await pay("https://api.example.com/a");
  await pay("https://api.example.com/b");

  assert.equal(pay.receipts.length, 2);
  assert.equal(pay.receipts[0]!.url, "https://api.example.com/a");
  assert.equal(pay.receipts[1]!.spentTotal, 0.008);
  assert.ok(Math.abs(pay.remaining - 0.992) < 1e-9);
});

test("remaining is Infinity when no budget was set", () => {
  const pay = x402Fetch({ maxPerCall: 1, settle });
  assert.equal(pay.remaining, Number.POSITIVE_INFINITY);
});

test("the receipt list cannot be mutated from outside", async () => {
  const server = payingServer();
  const pay = x402Fetch({ maxPerCall: 1, settle, fetch: server.doFetch });
  await pay("https://api.example.com/a");

  (pay.receipts as unknown as unknown[]).push("forged");
  assert.equal(pay.receipts.length, 1, "the audit trail must not be editable");
});

/* ── Dry run ────────────────────────────────────────────────────────────── */

test("dry run reports the quote and spends nothing", async () => {
  const server = payingServer();
  let settled = false;

  const pay = x402Fetch({
    maxPerCall: 0.01,
    dryRun: true,
    settle: async (r) => {
      settled = true;
      return settle(r);
    },
    fetch: server.doFetch,
  });

  const response = await pay("https://api.example.com/x");

  assert.equal(settled, false, "dry run must never settle");
  assert.equal(pay.spent, 0);
  assert.equal(response.status, 402, "the original 402 is handed back, not a retry");
  assert.equal(server.calls.length, 1, "no retry is made");

  assert.equal(pay.receipts.length, 1);
  assert.equal(pay.receipts[0]!.receipt.proof, "dry-run");
  assert.equal(pay.receipts[0]!.receipt.amount, 0.004);
});

test("dry run still refuses what a real run would refuse", async () => {
  // The point of a dry run is to find out whether a real run would work, so a
  // limit that would stop a payment must stop the dry run too.
  const overLimit = x402Fetch({
    maxPerCall: 0.001,
    dryRun: true,
    settle,
    fetch: (async () => terms(0.004)) as typeof fetch,
  });
  await assert.rejects(() => overLimit("https://api.example.com/x"), SpendLimitError);

  const overBudget = x402Fetch({
    maxPerCall: 1,
    maxTotal: 0.001,
    dryRun: true,
    settle,
    fetch: (async () => terms(0.004)) as typeof fetch,
  });
  await assert.rejects(() => overBudget("https://api.example.com/x"), BudgetExhaustedError);

  const wrongHost = x402Fetch({
    maxPerCall: 1,
    dryRun: true,
    allowHosts: ["api.crifine.app"],
    settle,
    fetch: (async () => terms(0.004)) as typeof fetch,
  });
  await assert.rejects(() => wrongHost("https://evil.example.com/x"), HostNotAllowedError);
});

test("dry run totals a run without paying for it", async () => {
  const pay = x402Fetch({
    maxPerCall: 1,
    dryRun: true,
    settle,
    fetch: (async () => terms(0.004)) as typeof fetch,
  });

  for (const path of ["a", "b", "c"]) await pay(`https://api.example.com/${path}`);

  const quoted = pay.receipts.reduce((total, r) => total + r.receipt.amount, 0);
  assert.ok(Math.abs(quoted - 0.012) < 1e-9, "the run would have cost 0.012");
  assert.equal(pay.spent, 0);
});

/* ── Refusal auditing ───────────────────────────────────────────────────── */

test("onRefusal sees the money that was stopped, not just the money that moved", async () => {
  const refusals: { url: string; name: string }[] = [];

  const pay = x402Fetch({
    maxPerCall: 0.001,
    settle,
    onRefusal: ({ url, error }) => refusals.push({ url, name: error.name }),
    fetch: (async () => terms(0.004)) as typeof fetch,
  });

  await assert.rejects(() => pay("https://api.example.com/x"));
  assert.deepEqual(refusals, [
    { url: "https://api.example.com/x", name: "SpendLimitError" },
  ]);
});

test("a budget refusal is audited too", async () => {
  const names: string[] = [];
  const server = payingServer();
  const pay = x402Fetch({
    maxPerCall: 1,
    maxTotal: 0.005,
    settle,
    onRefusal: ({ error }) => names.push(error.name),
    fetch: server.doFetch,
  });

  await pay("https://api.example.com/a");
  await assert.rejects(() => pay("https://api.example.com/b"));
  assert.deepEqual(names, ["BudgetExhaustedError"]);
});

test("a disallowed host is audited without trusting its stated terms", async () => {
  let seen: { amount: number } | undefined;
  const pay = x402Fetch({
    maxPerCall: 1,
    allowHosts: ["api.crifine.app"],
    settle,
    onRefusal: ({ request }) => { seen = request; },
    fetch: (async () => terms(999)) as typeof fetch,
  });

  await assert.rejects(() => pay("https://evil.example.com/x"), HostNotAllowedError);
  assert.equal(seen?.amount, 0, "terms from a refused host must not be reported as real");
});
