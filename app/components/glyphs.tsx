import type { SVGProps } from "react";

/**
 * The glyph set. Each is a tiny inline SVG, decorative unless a caller labels it.
 * Gold and bone are written literally: glyphs keep their colours whatever text colour surrounds them.
 */

type GlyphProps = Omit<SVGProps<SVGSVGElement>, "viewBox">;

const deco = { "aria-hidden": true, focusable: false } as const;

/** The mark: one gull. Strokes in the current colour. */
export const Gull = (p: GlyphProps) => (
  <svg viewBox="0 0 16 8" {...deco} {...p}>
    <path
      d="M1 5.6Q4.6 1.4 8 5.1Q11.4 1.4 15 5.6"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/** Meridian with the leader and the copy on it: the same-block mark. */
export const Meridian = (p: GlyphProps) => (
  <svg viewBox="0 0 13 13" {...deco} {...p}>
    <line x1="1.5" y1="11.5" x2="11.5" y2="1.5" stroke="#caa063" />
    <circle cx="9" cy="4" r="1.9" fill="#caa063" />
    <circle cx="4.6" cy="8.4" r="1.2" fill="#caa063" />
  </svg>
);

/** Feed glyph: copied in the same block (leader gold, your copy bone). */
export const GlyphSame = (p: GlyphProps) => (
  <svg viewBox="0 0 24 18" {...deco} {...p}>
    <line x1="3" y1="15" x2="21" y2="3" stroke="#caa063" />
    <circle cx="17" cy="5.7" r="2.6" fill="#caa063" />
    <circle cx="10" cy="10.3" r="1.6" fill="#e6dfcc" />
  </svg>
);

/** Feed glyph: an exit, copied (hollow bodies). */
export const GlyphExit = (p: GlyphProps) => (
  <svg viewBox="0 0 24 18" {...deco} {...p}>
    <line x1="3" y1="15" x2="21" y2="3" stroke="#caa063" />
    <circle cx="17" cy="5.7" r="2.6" fill="none" stroke="#caa063" />
    <circle cx="10" cy="10.3" r="1.6" fill="none" stroke="#e6dfcc" />
  </svg>
);

/** Feed glyph: refused (your copy stays hollow below the horizon). */
export const GlyphRefused = (p: GlyphProps) => (
  <svg viewBox="0 0 24 18" {...deco} {...p}>
    <line x1="1" y1="6" x2="23" y2="6" stroke="rgba(230,223,204,.55)" />
    <circle cx="12" cy="2.6" r="2.2" fill="#a79e8a" />
    <circle cx="12" cy="12.4" r="3.6" fill="none" stroke="#e6dfcc" strokeDasharray="1.6 1.8" />
  </svg>
);

/** Feed glyph: paused (half a body on the horizon). */
export const GlyphPaused = (p: GlyphProps) => (
  <svg viewBox="0 0 24 18" {...deco} {...p}>
    <line x1="1" y1="10" x2="23" y2="10" stroke="rgba(230,223,204,.55)" />
    <path d="M8.2 10a3.8 3.8 0 0 1 7.6 0" fill="none" stroke="#e6dfcc" />
  </svg>
);

/** Feed glyph: a committee verdict. */
export const GlyphVerdict = (p: GlyphProps) => (
  <svg viewBox="0 0 24 18" {...deco} {...p}>
    <circle cx="12" cy="9" r="7" fill="none" stroke="#e6dfcc" strokeDasharray="1 2.2" />
    <circle cx="12" cy="9" r="2.2" fill="#caa063" />
  </svg>
);

/** Feed glyph: a wallet joins a source (its copy, a ring, set on the leader's meridian). */
export const GlyphFollow = (p: GlyphProps) => (
  <svg viewBox="0 0 24 18" {...deco} {...p}>
    <line x1="3" y1="15" x2="21" y2="3" stroke="#caa063" strokeDasharray="2 2" />
    <circle cx="17" cy="5.7" r="2.6" fill="#caa063" />
    <circle cx="10" cy="10.3" r="2.4" fill="none" stroke="#e6dfcc" />
  </svg>
);

/** Feed glyph: a wallet leaves a source (its copy off the meridian). */
export const GlyphUnfollow = (p: GlyphProps) => (
  <svg viewBox="0 0 24 18" {...deco} {...p}>
    <line x1="3" y1="15" x2="21" y2="3" stroke="#caa063" strokeDasharray="2 2" />
    <circle cx="17" cy="5.7" r="2.6" fill="#caa063" />
    <circle cx="7" cy="5" r="2.4" fill="none" stroke="#e6dfcc" strokeDasharray="1.4 1.4" />
  </svg>
);

/** Verdict OK. */
export const VerdictOk = (p: GlyphProps) => (
  <svg viewBox="0 0 14 14" {...deco} {...p}>
    <circle cx="7" cy="7" r="5.5" fill="none" stroke="#e6dfcc" />
    <circle cx="7" cy="7" r="2.6" fill="#e6dfcc" />
  </svg>
);

/** Verdict CAUTION: half-filled gold. */
export const VerdictCaution = (p: GlyphProps) => (
  <svg viewBox="0 0 14 14" {...deco} {...p}>
    <circle cx="7" cy="7" r="5.5" fill="none" stroke="#caa063" />
    <path d="M7 1.5A5.5 5.5 0 0 1 7 12.5Z" fill="#caa063" />
  </svg>
);

/** Verdict BLOCK: dashed and barred. */
export const VerdictBlock = (p: GlyphProps) => (
  <svg viewBox="0 0 14 14" {...deco} {...p}>
    <circle cx="7" cy="7" r="5.5" fill="none" stroke="#e6dfcc" strokeDasharray="1.6 1.6" />
    <line x1="2.6" y1="11.4" x2="11.4" y2="2.6" stroke="#e6dfcc" />
  </svg>
);

/** The CTA arrow. */
export const Arrow = (p: GlyphProps) => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" {...deco} {...p}>
    <path d="M2 8h11M9 4l4 4-4 4" />
  </svg>
);
