/** Base for everything this package refuses to do. */
export class X402Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = "X402Error";
  }
}

/** The server asked for more than the caller allowed for one call. */
export class SpendLimitError extends X402Error {
  constructor(
    readonly asked: number,
    readonly limit: number,
    readonly currency: string,
  ) {
    super(
      `payment of ${asked} ${currency} exceeds maxPerCall of ${limit} ${currency} — refusing to pay`,
    );
    this.name = "SpendLimitError";
  }
}

/** The caller's cumulative budget for this wrapper is exhausted. */
export class BudgetExhaustedError extends X402Error {
  constructor(
    readonly spent: number,
    readonly limit: number,
    readonly currency: string,
  ) {
    super(
      `budget exhausted: ${spent} of ${limit} ${currency} already spent — refusing to pay`,
    );
    this.name = "BudgetExhaustedError";
  }
}

/** The 402 came from a host the caller did not allow. */
export class HostNotAllowedError extends X402Error {
  constructor(readonly host: string) {
    super(`refusing to pay ${host} — not in allowHosts`);
    this.name = "HostNotAllowedError";
  }
}

/** The 402 response did not state terms this package can act on. */
export class MalformedTermsError extends X402Error {
  constructor(reason: string) {
    super(`cannot read payment terms: ${reason}`);
    this.name = "MalformedTermsError";
  }
}
