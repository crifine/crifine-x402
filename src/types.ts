/** The payment terms a server states in its 402 response. */
export type PaymentRequest = {
  /** Decimal amount, as stated by the server. */
  amount: number;
  /** Currency ticker, e.g. "USDC". */
  currency: string;
  /** Settlement network, e.g. "base". */
  network: string;
  /** Where to settle to. */
  recipient?: string;
  /** Opaque value the server wants echoed back, if any. */
  nonce?: string;
};

/** Proof that a payment settled, handed back on the retry. */
export type PaymentReceipt = {
  /** Value for the `X-Payment-Proof` header. */
  proof: string;
  /** What was actually spent, for the audit trail. */
  amount: number;
  currency: string;
  network: string;
};

/**
 * Settles a payment. Supplied by the caller — this package never holds keys
 * and never signs anything itself.
 */
export type Settle = (request: PaymentRequest) => Promise<PaymentReceipt>;

export type PaymentEvent = {
  url: string;
  request: PaymentRequest;
  receipt: PaymentReceipt;
  /** Running total spent by this wrapper instance. */
  spentTotal: number;
};
