const intFormat = new Intl.NumberFormat("en-US");

/** `35025602` → `35,025,602`. */
export const fmtInt = (n: number | bigint) => intFormat.format(n);

/** `0xa1d0cb85…57b5d` → `0xa1d0…7b5d`. Keeps the input's case. */
export const shortHex = (hex: string, head = 4, tail = 4) =>
  hex.length <= 2 + head + tail ? hex : `${hex.slice(0, 2 + head)}…${hex.slice(-tail)}`;
