"use client";

import { useEffect } from "react";

/**
 * Plays the rise on each `.reveal` element as it scrolls into view.
 *
 * Until this runs, a CSS failsafe shows every `.reveal` at 3.5 s. When it mounts it takes over (`html.reveal-js`
 * switches the failsafe off): anything the failsafe already showed is marked `.shown` and never fades again, the
 * rest rise as they enter. Without IntersectionObserver everything is shown; with reduced motion nothing animates.
 */
export function RevealObserver() {
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const els = [...document.querySelectorAll<HTMLElement>(".reveal")];
    // read before taking over: an element the failsafe has already shown keeps its opacity
    const shown = new Set(els.filter((el) => parseFloat(getComputedStyle(el).opacity) > 0.5));
    shown.forEach((el) => el.classList.add("shown"));
    document.documentElement.classList.add("reveal-js");
    const pending = els.filter((el) => !shown.has(el));
    if (!("IntersectionObserver" in window)) {
      pending.forEach((el) => el.classList.add("in"));
      return () => document.documentElement.classList.remove("reveal-js");
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          e.target.classList.add("in");
          io.unobserve(e.target);
        }
      },
      { rootMargin: "0px 0px -8% 0px" },
    );
    pending.forEach((el) => io.observe(el));
    return () => {
      io.disconnect();
      document.documentElement.classList.remove("reveal-js");
    };
  }, []);
  return null;
}
