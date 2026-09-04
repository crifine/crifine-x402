/**
 * `402 Payment Required` → pay → retry, as a `fetch` wrapper.
 *
 * ── The constraint that shapes this package ──────────────────────────────
 * This library spends money automatically, on behalf of a program that may run
 * unattended for hours. Every design choice below follows from that:
 *
 * - `maxPerCall` is **required and has no default**. There is deliberately no
 *   code path in which this wrapper pays an amount the caller did not bound.
 * - It never holds a key. Settlement is a callback the caller supplies.
 * - It pays at most once per request, and never retries a payment.
 * - Refusals throw typed errors, so an agent can tell "too expensive" apart
 *   from "the server is broken".
 *
 * It works with any API that speaks x402, not just Crifine — which is why it
 * has no dependency on `@crifine/sdk`.
 */

import {
  BudgetExhaustedError,
  HostNotAllowedError,
  MalformedTermsError,
  SpendLimitError,
  X402Error,
} from "./errors.js";
import type { PaymentEvent, PaymentRequest, PaymentReceipt, Settle } from "./types.js";

export * from "./types.js";
export * from "./errors.js";
export * from "./settlers.js";

export type X402Options = {
  /**
   * Hard ceiling for a single call, in the currency the server quotes.
   * Required: a wrapper that pays an unbounded amount is not something a
   * caller can reason about.
   */
  maxPerCall: number;
  /** Settles payment. Without it, a 402 is returned to the caller untouched. */
  settle?: Settle;
  /** Cumulative ceiling across the life of this wrapper. */
  maxTotal?: number;
  /** Hosts allowed to charge. Omit to allow any. */
  allowHosts?: string[];
  /** Audit hook, called after each successful settlement. */
  onPayment?: (event: PaymentEvent) => void;
  /**
   * Most payments in flight at once. Default 1.
   *
   * Serialised by default on purpose: with parallel calls, two 402s can both
   * read the budget before either has spent, and the pair sails past a limit
   * each of them individually respected. An unattended agent fanning out ten
   * requests would blow through `maxTotal` without a single check failing.
   * Raise it only if you can tolerate that.
   */
  concurrency?: number;
  /**
   * Report what would be paid, and pay nothing.
   *
   * A library that spends money automatically should be runnable once with the
   * spending switched off. In dry run the 402 is still parsed and still checked
   * against every limit — so a run that would have been refused is still
   * refused — and the quote is recorded in `receipts` with a `proof` of
   * `"dry-run"`. The original 402 is returned; no retry is made.
   */
  dryRun?: boolean;
  /**
   * Called when a payment is refused. Pairs with `onPayment`: without it, the
   * audit trail only shows the money that moved, never the money that was
   * stopped.
   */
  onRefusal?: (refusal: { url: string; request: PaymentRequest; error: X402Error }) => void;
  /** Underlying fetch. Defaults to global. */
  fetch?: typeof fetch;
};

/** Reads the terms a server states in its 402 headers. */
export function readTerms(response: Response): PaymentRequest {
  const amount = Number(response.headers.get("x-payment-amount"));
  const currency = response.headers.get("x-payment-currency");
  const network = response.headers.get("x-payment-network");

  if (!Number.isFinite(amount) || amount <= 0) {
    throw new MalformedTermsError("X-Payment-Amount is missing or not a positive number");
  }
  if (!currency) throw new MalformedTermsError("X-Payment-Currency is missing");
  if (!network) throw new MalformedTermsError("X-Payment-Network is missing");

  const recipient = response.headers.get("x-payment-recipient");
  const nonce = response.headers.get("x-payment-nonce");

  return {
    amount,
    currency,
    network,
    ...(recipient ? { recipient } : {}),
    ...(nonce ? { nonce } : {}),
  };
}

export type X402Fetch = typeof fetch & {
  /** Total settled by this wrapper so far. */
  readonly spent: number;
  /** Number of payments settled. */
  readonly payments: number;
  /** Every settlement, in order. An audit trail without wiring a callback. */
  readonly receipts: readonly PaymentEvent[];
  /** Remaining budget, or Infinity when no `maxTotal` was set. */
  readonly remaining: number;
};

export type ScopedX402Fetch = X402Fetch & {
  /**
   * A child wrapper with a tighter budget of its own, spending from the same
   * ledger as its parent.
   *
   * The case this exists for: one long-lived wrapper holds the day's budget,
   * and each task carves off a slice it cannot exceed. Without it, a task that
   * misbehaves can only be bounded by the whole day's allowance.
   */
  withBudget: (maxTotal: number, overrides?: Partial<X402Options>) => ScopedX402Fetch;
};

export function x402Fetch(options: X402Options): ScopedX402Fetch {
  if (!(options.maxPerCall > 0)) {
    throw new X402Error(
      "maxPerCall is required and must be greater than zero — this wrapper will not pay an unbounded amount",
    );
  }

  const doFetch = options.fetch ?? fetch;
  const allowed = options.allowHosts?.map((host) => host.toLowerCase());

  let spent = 0;
  let payments = 0;
  const receipts: PaymentEvent[] = [];

  // A promise chain, not a counter: the point is that budget checks and the
  // spend that follows them cannot interleave.
  const limit = Math.max(1, options.concurrency ?? 1);
  let running = 0;
  const queue: (() => void)[] = [];

  const acquire = async () => {
    if (running < limit) {
      running += 1;
      return;
    }
    await new Promise<void>((resolve) => queue.push(resolve));
    running += 1;
  };

  const release = () => {
    running -= 1;
    queue.shift()?.();
  };

  // Derived from `fetch` itself rather than naming `RequestInfo`, which is a
  // DOM global and is not declared by @types/node.
  type FetchInput = Parameters<typeof fetch>[0];

  const wrapped = (async (input: FetchInput, init?: RequestInit) => {
    const first = await doFetch(input, init);
    if (first.status !== 402) return first;
    if (!options.settle) return first;

    const url = new URL(
      typeof input === "string" || input instanceof URL ? String(input) : input.url,
    );

    if (allowed && !allowed.includes(url.host.toLowerCase())) {
      const error = new HostNotAllowedError(url.host);
      options.onRefusal?.({
        url: url.toString(),
        // Terms are not trusted from a host we refused to talk to.
        request: { amount: 0, currency: "", network: "" },
        error,
      });
      throw error;
    }

    // Terms are read before any spend decision so a malformed 402 can never be
    // paid "just in case".
    const terms = readTerms(first);

    const refuse = (error: X402Error): never => {
      options.onRefusal?.({ url: url.toString(), request: terms, error });
      throw error;
    };

    if (terms.amount > options.maxPerCall) {
      refuse(new SpendLimitError(terms.amount, options.maxPerCall, terms.currency));
    }

    await acquire();
    let receipt: PaymentReceipt;
    let event: PaymentEvent;

    try {
      // Re-checked inside the gate: another call may have spent while this one
      // waited, and the budget it was checked against is now stale.
      if (options.maxTotal !== undefined && spent + terms.amount > options.maxTotal) {
        refuse(new BudgetExhaustedError(spent, options.maxTotal, terms.currency));
      }

      // Every limit has now been checked. In dry run that is the whole job:
      // record the quote, spend nothing, and hand back the 402 unchanged.
      if (options.dryRun) {
        const quote: PaymentEvent = {
          url: url.toString(),
          request: terms,
          receipt: {
            proof: "dry-run",
            amount: terms.amount,
            currency: terms.currency,
            network: terms.network,
          },
          spentTotal: spent,
        };
        receipts.push(quote);
        options.onPayment?.(quote);
        return first;
      }

      receipt = await options.settle(terms);

      // The ledger moves on the receipt, not the quote: if settlement came
      // back with a different amount, that is what was actually spent.
      spent += receipt.amount;
      payments += 1;
      event = { url: url.toString(), request: terms, receipt, spentTotal: spent };
      receipts.push(event);
    } finally {
      release();
    }

    options.onPayment?.(event);

    const headers = new Headers(init?.headers);
    headers.set("x-payment-proof", receipt.proof);

    const retried = await doFetch(input, { ...init, headers });

    // One payment per request, always. A second 402 is handed back rather than
    // paid again — an endpoint that keeps asking is a bug, and paying into a
    // loop is how an unattended agent empties a wallet.
    return retried;
  }) as ScopedX402Fetch;

  // A child settles through the parent, so both ledgers move together and the
  // parent's ceiling still binds. A child that kept its own settle callback
  // could spend past a parent limit without the parent ever noticing.
  const withBudget = (maxTotal: number, overrides: Partial<X402Options> = {}): ScopedX402Fetch => {
    if (!(maxTotal > 0)) {
      throw new X402Error("a scoped budget must be greater than zero");
    }

    let scopedSpent = 0;

    return x402Fetch({
      ...options,
      ...overrides,
      maxPerCall: Math.min(
        overrides.maxPerCall ?? options.maxPerCall,
        options.maxPerCall,
      ),
      maxTotal,
      settle: async (request) => {
        if (scopedSpent + request.amount > maxTotal) {
          throw new BudgetExhaustedError(scopedSpent, maxTotal, request.currency);
        }
        if (!options.settle) {
          throw new X402Error("the parent wrapper has no settle callback");
        }

        const receipt = await options.settle(request);
        scopedSpent += receipt.amount;

        // Charged to the parent as well, so its ceiling is real.
        spent += receipt.amount;
        payments += 1;
        return receipt;
      },
    });
  };

  Object.defineProperties(wrapped, {
    withBudget: { value: withBudget, enumerable: true },
    spent: { get: () => spent, enumerable: true },
    payments: { get: () => payments, enumerable: true },
    receipts: { get: () => [...receipts], enumerable: true },
    remaining: {
      get: () =>
        options.maxTotal === undefined
          ? Number.POSITIVE_INFINITY
          : Math.max(0, options.maxTotal - spent),
      enumerable: true,
    },
  });

  return wrapped;
}
