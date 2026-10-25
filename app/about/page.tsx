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
        Upload images, an image archive or a PDF. Choose the source and target
        language, then start processing. The hosted version reads text with
        OCR.space and translates dialogue with DeepL. Your open browser tab
        prepares images, applies conservative cleanup and fits translated text.
        Private files and progress are saved in Supabase.
      </p>
      <p>
        Keep a tab open until processing finishes. If interrupted, reopen the
        chapter and resume. The hosted app runs independently of the owner's PC.
        Free provider and storage quotas limit how much it can process.
      </p>
      <h2>Honest about quality</h2>
      <p>
        Stylized lettering, handwriting, vertical dialogue and complex
        backgrounds can produce errors. OCR.space provides text positions
        without confidence scores. Every processed page needs manual review.
        Cleanup targets simple white backgrounds; uncertain artwork and text
        that cannot fit at 12px are preserved for correction in the editor.
      </p>
      <p>
        The separate Python deployment supports local OCR, Argos translation,
        OpenCV cleanup and additional providers. Those features require a
        running backend and are unavailable in the free browser processing mode.
      </p>
      <h2>Private by design</h2>
      <p>
        Each library belongs to a temporary browser session. Clearing cookies
        removes access. Files are private and downloads use short-lived signed
        links. Originals and processed images are separate. Projects expire
        after seven days and are cleaned up when the library is accessed. You
        can delete a paused chapter in the app.
      </p>
      <p>
        OCR.space receives page image tiles. DeepL receives recognized text and
        nearby dialogue as context. Provider keys stay on the server. There is
        no public sharing endpoint or account recovery for temporary libraries.
      </p>
      <h2>Content permissions</h2>
      <p>
        Only upload, translate or export content you have permission to use. The
        local Python deployment supports URL imports from explicitly authorized
        manifest hosts. MangaLens does not bypass paywalls, DRM, login
        requirements or anti-bot protections. No commercial manga source is
        enabled by default.
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
