import sharp from "sharp";

const originalFetch = globalThis.fetch;
let sentRateLimit = false;
globalThis.fetch = async (input, options) => {
  const url = new URL(
    typeof input === "object" && "url" in input ? input.url : String(input),
  );
  if (url.hostname === "api.ocr.space") {
    const encoded = options.body.get("base64Image").split(",")[1];
    const { data, info } = await sharp(Buffer.from(encoded, "base64"))
      .toColourspace("srgb")
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    let left = info.width,
      top = info.height,
      right = -1,
      bottom = -1;
    let rateLimitMarker = false;
    for (let y = 0; y < info.height; y++)
      for (let x = 0; x < info.width; x++) {
        const i = (y * info.width + x) * 3;
        if (data[i] < 60 && data[i + 1] > 180 && data[i + 2] < 60)
          rateLimitMarker = true;
        if (data[i] > 150 && data[i + 1] < 80 && data[i + 2] < 80)
          throw new Error("An outside marker reached OCR.");
        if (Math.max(data[i], data[i + 1], data[i + 2]) < 110) {
          left = Math.min(left, x);
          top = Math.min(top, y);
          right = Math.max(right, x);
          bottom = Math.max(bottom, y);
        }
    if (rateLimitMarker && !sentRateLimit) {
      sentRateLimit = true;
      return new Response(null, { status: 429, headers: { "Retry-After": "3" } });
    }
      }
    return Response.json({
      OCRExitCode: 1,
      ParsedResults: [
        {
          FileParseExitCode: 1,
          ParsedText: "Hello!",
          TextOverlay: {
            Lines:
              right < 0
                ? []
                : [
                    {
                      LineText: "Hello!",
                      Words: [
                        {
                          WordText: "Hello!",
                          Left: left,
                          Top: top,
                          Width: right - left + 1,
                          Height: bottom - top + 1,
                        },
                      ],
                    },
                  ],
          },
        },
      ],
    });
  }
  if (["api-free.deepl.com", "api.deepl.com"].includes(url.hostname)) {
    const { text, context } = JSON.parse(options.body);
    if (text.some((item) => item !== "Hello!") || /OUTSIDE/.test(context))
      throw new Error("Unapproved text reached DeepL.");
    return Response.json({
      translations: text.map(() => ({
        text: "A new chapter",
        detected_source_language: "EN",
      })),
    });
  }
  return originalFetch(input, options);
};
