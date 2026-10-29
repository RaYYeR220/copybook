"""
Builds the hero headline's own font files: Fraunces at the exact instances the landing's H1 draws ("Follow a trader /
or a" at weight 560, "thesis." italic at 500, both at opsz 144 and SOFT 100), cut to the characters the H1 uses. A few
KB each, so the page can preload them instead of the full variable faces (about 270 KB) and still paint the headline
in Fraunces. Every other piece of Fraunces text keeps using the full variable font, and a character missing here falls
back to it.

    pip install "fonttools[woff]"
    python app/scripts/hero-font.py        # writes app/assets/fonts/fraunces-hero-*.woff2

Run it again when the H1's text, weight, style or variation settings change (components/Hero/Hero.tsx).
"""
import io
import re
import urllib.request
from pathlib import Path

from fontTools.subset import Options, Subsetter
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

CSS_URL = (
    "https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght,SOFT@0,9..144,100..900,0..100;1,9..144,100..900,0..100"
)
# a browser user agent, so Google answers with woff2 and per-subset files
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
OUT = Path(__file__).resolve().parent.parent / "assets" / "fonts"
INSTANCES = {
    "fraunces-hero-560.woff2": ("normal", {"wght": 560, "opsz": 144, "SOFT": 100}, "Follow a trader or a"),
    "fraunces-hero-italic-500.woff2": ("italic", {"wght": 500, "opsz": 144, "SOFT": 100}, "thesis."),
}


def fetch(url: str) -> bytes:
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA})) as r:
        return r.read()


def latin_sources() -> dict[str, str]:
    css = fetch(CSS_URL).decode()
    out = {}
    for block in re.findall(r"/\* latin \*/\s*@font-face\s*{([^}]*)}", css):
        style = re.search(r"font-style:\s*(\w+)", block).group(1)
        out[style] = re.search(r"url\((https://[^)]+)\)", block).group(1)
    return out


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    sources = latin_sources()
    for name, (style, location, text) in INSTANCES.items():
        font = instancer.instantiateVariableFont(TTFont(io.BytesIO(fetch(sources[style]))), location)
        opts = Options()
        opts.flavor = "woff2"
        opts.layout_features = ["*"]
        opts.name_IDs = ["*"]
        sub = Subsetter(opts)
        sub.populate(text=text + " ")
        sub.subset(font)
        font.flavor = "woff2"
        font.save(OUT / name)
        print(name, (OUT / name).stat().st_size, "bytes")


if __name__ == "__main__":
    main()
