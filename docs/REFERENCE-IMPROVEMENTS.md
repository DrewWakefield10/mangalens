# Translator reference review

Reviewed the four linked projects on 2026-10-11. These are design references, not imported code or bundled dependencies.

| Project | Relevant approach | MangaLens decision |
| --- | --- | --- |
| [Koharu](https://github.com/koharu-rs/koharu) | Selective detection/OCR/translation/inpainting stages, separate layout and cleanup segmentation, proofreading, and layered editing | Preserve our existing stage-specific retries. Make proposed masks inspectable before adding more automatic cleanup. |
| [manga-image-translator](https://github.com/zyddnys/manga-image-translator) | Adjustable mask dilation and detection/inpainting settings; distinguishes text detection leakage from inpainting leakage; bubble-aware English fitting | Keep the existing source-box, include/exclude, dilation, and fit controls. Expose the proposed mask beside the applied mask so the two failure modes can be distinguished visually. |
| [manga-translator-ui](https://github.com/hgmzhn/manga-translator-ui) | Mask brush and eraser, original comparison, shaped-bubble typesetting, layered output, and editor shortcuts | The proposed-mask view is the first low-risk editor improvement. Persisted mask painting and shaped-bubble layout are the next candidates. |
| [MangaTranslator](https://github.com/meangrinch/MangaTranslator) | Speech-bubble and outside-bubble segmentation, cleaning-only mode, configurable fonts, and OpenCV or model-based restoration | Evaluate a manual cleaning-only workflow and an optional local artwork inpainter after mask-quality tests. Keep the current conservative default for text on faces, titles, and panel art. |

## Implemented here

The editor's **Proposed mask** view draws the selected region's candidate mask in pink on the original page. It uses the same `build_text_mask` function as the cleanup pipeline, so its pixels are in original-image coordinates. It is read-only and revision-checked. The existing **Mask** view remains the actual applied removal mask. This helps explain pages where a detector found a text box but the application correctly refused to erase it.

## Next improvements to validate on real pages

1. **Persisted mask brush and eraser.** Store add/remove bitmap strokes by region and page revision, show them on the proposed mask, and run the existing artwork and residual-lettering gates before applying them. Page 001's title and chapter lettering are useful acceptance cases; rectangular include boxes alone cannot follow their strokes safely.
2. **Separate outside-bubble cleanup.** Benchmark a local segmentation/inpainting model against the current OpenCV path on title, caption, and sound-effect regions. Compare removed-text coverage and artwork preservation, then make it opt-in until those checks pass. Model size, runtime, and licenses need review before packaging.
3. **Bubble-shaped line fitting.** Use the detected bubble interior width at each line height and preserve the current strict overflow check. Test narrow vertical Japanese bubbles with long English output and ensure no word or punctuation disappears.
4. **Cleaning-only and layered handoff.** Allow a confirmed region to be cleaned without automatic translation, then export original, cleaned page, and text-placement metadata as separately editable assets. Keep normal translated reading unchanged.

Current OCR crop recognition already upsamples small selections and retries enhanced contrast; the reader already compares translated and original pages. Replacing those paths with another project's code would add maintenance cost without addressing the documented page 001 failures.
