import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** A face as next/og takes it: TTF bytes (satori reads no WOFF2). */
export interface OgFont {
  name: string;
  data: ArrayBuffer;
  weight: 400 | 500 | 600;
  style: "normal" | "italic";
}

/** The site's three families as static TTF instances (assets/og, OFL), Fraunces at opsz 144 with SOFT 0: night. */
const FACES = [
  { file: "Fraunces-144pt-SemiBold.ttf", name: "Fraunces", weight: 600, style: "normal" },
  { file: "Fraunces-144pt-MediumItalic.ttf", name: "Fraunces", weight: 500, style: "italic" },
  { file: "FragmentMono-Regular.ttf", name: "Fragment Mono", weight: 400, style: "normal" },
  { file: "Figtree-Regular.ttf", name: "Figtree", weight: 400, style: "normal" },
  { file: "Figtree-Medium.ttf", name: "Figtree", weight: 500, style: "normal" },
] as const;

let loaded: Promise<OgFont[]> | undefined;

/** Read once per process. The files ship with the functions through `outputFileTracingIncludes`. */
export function ogFonts(dir = join(process.cwd(), "assets", "og")): Promise<OgFont[]> {
  loaded ??= Promise.all(
    FACES.map(async (f) => {
      const buf = await readFile(join(dir, f.file));
      return { name: f.name, weight: f.weight, style: f.style, data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer };
    }),
  ).catch((e) => {
    loaded = undefined;
    throw e;
  });
  return loaded;
}
