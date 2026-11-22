const assets = {
  MangaLensDialogue: "MangaLensDialogue-Regular.otf",
  MangaLensThai: "NotoSansThai.ttf",
  MangaLensCJK: "NotoSansCJKjp-Regular.otf",
};

export function typesettingFamily(text: string): keyof typeof assets {
  if (/[\u0e00-\u0e7f]/u.test(text)) return "MangaLensThai";
  return /[^\u0000-\u052f\u1d00-\u1eff\u2000-\u22ff]/u.test(text)
    ? "MangaLensCJK"
    : "MangaLensDialogue";
}

export function loadTypesettingFont(family: keyof typeof assets) {
  return loadFont(family, assets[family]);
}

const fonts = new Map<string, Promise<void>>();
function loadFont(family: string, filename: string) {
  let pending = fonts.get(family);
  if (!pending) {
    pending = new FontFace(family, `url(/fonts/${filename})`)
      .load()
      .then((face) => {
        document.fonts.add(face);
      })
      .catch(() => {
        fonts.delete(family);
        throw new Error(
          "The typesetting font could not load. Check your connection and retry.",
        );
      });
    fonts.set(family, pending);
  }
  return pending;
}
