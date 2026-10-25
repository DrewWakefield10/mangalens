import Link from "next/link";
export default function About() {
  return (
    <main className="workspace prose">
      <div className="eyebrow">READ BEYOND LANGUAGE BARRIERS</div>
      <h1>The story comes first.</h1>
      <p className="lead">
        MangaLens brings translation tools closer to the page, with the original
        artwork always within reach.
      </p>
      <h2>How it works</h2>
      <p>
        Upload your images, an image archive or a PDF. Choose a source language
        and target language, then start processing. The server reads text using
        local OCR and optional OCR.space cloud OCR, sends recognized dialogue
        to DeepL by default, removes lettering through targeted masks and OpenCV
        inpainting, and fits new text into the detected region. Pages appear in
        the reader as they finish.
      </p>
      <h2>Honest about quality</h2>
      <p>
        This is a working CPU baseline, not professional scanlation. Stylized
        lettering, handwriting, vertical dialogue and complex backgrounds can
        produce errors. Tesseract detects text blocks, not semantic speech
        bubbles. Review OCR, compare the original and inspect every cleanup.
        Regions that cannot fit readable text preserve their original lettering
        and are flagged for correction.
      </p>
      <p>
        DeepL receives nearby dialogue as context and reports account character
        usage. Argos remains an offline option. Maximum Quality uses the full
        local OCR recovery pipeline and, when configured, OCR.space free OCR.
        Fast uses fewer OCR retries. An optional
        OpenAI-compatible or Ollama provider can use a contextual review prompt.
        Automated review is not proof of correctness.
      </p>
      <h2>Private by design</h2>
      <p>
        Every project belongs to a private temporary browser session. Assets
        require that session to access them. Original and processed images are
        stored separately. Default retention is seven days. You can delete
        projects and cached processing data in the app. There is no public
        sharing endpoint.
      </p>
      <p>
        With Argos and local OCR, image and text processing stay on your server.
        DeepL receives recognized source text and chapter context. OCR.space
        receives page images only if its separate OCR key is configured
        and Maximum Quality is selected. You can choose a configured translation
        fallback in Settings; the provider used is recorded in page metadata.
      </p>
      <h2>Content permissions</h2>
      <p>
        Only upload, translate or export content you have permission to use. URL
        import supports explicitly authorized public JSON manifest hosts.
        MangaLens does not bypass paywalls, DRM, login requirements or anti-bot
        protections. No commercial manga source is enabled by default.
      </p>
      <h2>Sample materials</h2>
      <p>
        The homepage comic is original vector artwork created for MangaLens and
        released under CC0. Its English lettering is a human-authored
        illustration, not an automatic translation result. The repository
        includes a separate Japanese OCR test page and a script that records
        actual processing output. Noto fonts are distributed under the SIL Open
        Font License.
      </p>
      <Link className="button primary" href="/translate">
        Start your next chapter →
      </Link>
    </main>
  );
}
