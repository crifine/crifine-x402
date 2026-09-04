/**
 * A reference settler for USDC over EVM.
 *
 * `viem` is imported dynamically and declared as an *optional* peer: a caller
 * who brings their own settlement — a custodial API, a session key, a paymaster
 * — should not have to install a wallet library to use the wrapper. Importing
 * it at module scope would make it mandatory in practice, whatever package.json
 * says.
 *
 * This is a reference, not a policy. It moves real money; read it before you
 * point it at a funded account.
 */

import { X402Error } from "./errors.js";
import type { PaymentRequest, PaymentReceipt, Settle } from "./types.js";

/** USDC contract per network. Extend deliberately — a wrong address burns funds. */
export const USDC: Record<string, `0x${string}`> = {
  base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  ethereum: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  arbitrum: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
};

const USDC_DECIMALS = 6;

/** Decimal string → integer base units, without floating point. */
export function toBaseUnits(amount: number, decimals = USDC_DECIMALS): bigint {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new X402Error(`cannot settle a non-positive amount: ${amount}`);
  }

  // Via string so 0.004 does not become 0.004000000000000000083.
  const [whole = "0", fraction = ""] = amount.toFixed(decimals).split(".");
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0"));
}

export type UsdcSettlerOptions = {
  /** A viem WalletClient with an account attached. */
  walletClient: unknown;
  /** Override or extend the token map. */
  tokens?: Record<string, `0x${string}`>;
  /** Wait for the transaction to be mined before returning. Default true. */
  waitForReceipt?: boolean;
};

/**
 * Builds a `Settle` that transfers USDC with viem.
 *
 * Requires `viem` to be installed by the caller. Every refusal below is
 * deliberate: this function would rather fail than guess where to send money.
 */
export function usdcSettler(options: UsdcSettlerOptions): Settle {
  const tokens = { ...USDC, ...options.tokens };

  return async function settle(request: PaymentRequest): Promise<PaymentReceipt> {
    if (request.currency.toUpperCase() !== "USDC") {
      throw new X402Error(`this settler only handles USDC, not ${request.currency}`);
    }

    const token = tokens[request.network.toLowerCase()];
    if (!token) {
      throw new X402Error(
        `no USDC address known for network "${request.network}" — pass one via tokens rather than letting this guess`,
      );
    }
    if (!request.recipient) {
      throw new X402Error("the 402 stated no recipient — refusing to send funds nowhere");
    }

    let viem: typeof import("viem");
    try {
      viem = await import("viem");
    } catch {
      throw new X402Error(
        "usdcSettler needs viem installed: npm install viem — or supply your own settle callback",
      );
    }

    const wallet = options.walletClient as {
      writeContract: (args: unknown) => Promise<`0x${string}`>;
      waitForTransactionReceipt?: (args: { hash: `0x${string}` }) => Promise<unknown>;
      account?: unknown;
      chain?: unknown;
    };

    const hash = await wallet.writeContract({
      address: token,
      abi: viem.parseAbi([
        "function transfer(address to, uint256 amount) returns (bool)",
      ]),
      functionName: "transfer",
      args: [request.recipient as `0x${string}`, toBaseUnits(request.amount)],
      account: wallet.account,
      chain: wallet.chain,
    });

    if (options.waitForReceipt !== false && wallet.waitForTransactionReceipt) {
      await wallet.waitForTransactionReceipt({ hash });
    }

    return {
      proof: hash,
      amount: request.amount,
      currency: request.currency,
      network: request.network,
    };
  };
}
