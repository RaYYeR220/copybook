import { formatUnits, getAddress, isAddress, parseUnits, type Address } from "viem";
import { z } from "zod";

/**
 * Money an agent types or reads is a decimal string; the chain's 18-decimal integers never leak out.
 * Schemas stay transform-free (they are published to the client as JSON Schema); the handlers convert.
 */
const DECIMAL = /^\d+(\.\d{1,18})?$/;

export class InputError extends Error {}

const decimal = (what: string, unit: string) =>
  z
    .union([z.string(), z.number()])
    .describe(`${what}, in ${unit}, as a plain decimal like "250" or "0.5" (no exponent, at most 18 decimals)`);

export const usdsoField = (what: string) => decimal(what, "USDso");
export const sttField = (what: string) => decimal(what, "STT");

export function parseDecimal(v: string | number, what: string): bigint {
  const s = typeof v === "number" ? (Number.isFinite(v) ? String(v) : "") : v.trim();
  if (!DECIMAL.test(s)) throw new InputError(`${what} must be a plain decimal like "250" or "0.5" (no exponent, at most 18 decimals); got ${JSON.stringify(v)}`);
  return parseUnits(s, 18);
}

export const addressField = (what: string) => z.string().describe(`${what}: a 0x address`);

export function parseAddress(v: string, what: string): Address {
  if (!isAddress(v, { strict: false })) throw new InputError(`${what} must be a 0x address; got ${JSON.stringify(v)}`);
  return getAddress(v);
}

export const fmt = (v: bigint): string => formatUnits(v, 18);
