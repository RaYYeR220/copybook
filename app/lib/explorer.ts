import { EXPLORER_URL } from "./wallet/hideki";

export const txUrl = (hash: string) => `${EXPLORER_URL}/tx/${hash}`;
export const addressUrl = (address: string) => `${EXPLORER_URL}/address/${address}`;
export const blockUrl = (block: number | bigint) => `${EXPLORER_URL}/block/${block}`;

/** Shannon, where the AI guard's committee reaches its verdict. */
export const SHANNON_EXPLORER_URL = "https://shannon-explorer.somnia.network";
export const shannonTxUrl = (hash: string) => `${SHANNON_EXPLORER_URL}/tx/${hash}`;
