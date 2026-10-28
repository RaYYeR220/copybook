import type { CSSProperties } from "react";

/** Entrance delay for `.rise` / `.reveal`, in seconds. */
export const delay = (s: number) => ({ "--d": `${s}s` }) as CSSProperties;
