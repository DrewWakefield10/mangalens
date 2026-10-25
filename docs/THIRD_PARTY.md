# Third-party and sample notices

- `assets/fonts/NotoSansCJKjp-Regular.otf`: Noto CJK by the Noto project, SIL Open Font License 1.1; full license in `assets/fonts/OFL.txt`. Download source recorded in `scripts/setup_models.py`.
- Tesseract language data: downloaded from `tesseract-ocr/tessdata_fast`, Apache 2.0; upstream license: https://github.com/tesseract-ocr/tessdata_fast/blob/main/LICENSE.
- Argos model packages: obtained from the official public Argos index and distribution hosts. Upstream package README, metadata and any included notices are preserved in `models/argos/<pair>/`. Models include training-data dependencies with their own provenance; consult the package README before redistributing weights. Downloaded weights are ignored by Git and not bundled into the application source.
- Argos Translate: MIT/CC0 project; CTranslate2: MIT; SentencePiece: Apache 2.0. This application directly invokes CTranslate2 using the package's SentencePiece tokenizer or Moses/BPE via `sacremoses` and `subword-nmt`, which retain their upstream licenses. Format reference: https://github.com/argosopentech/argos-translate/blob/master/argostranslate/tokenizer.py.
- Pillow: HPND; OpenCV: Apache 2.0; PDFium via pypdfium2: upstream PDFium/BSD-style and wrapper licenses. Installed distributions retain their licenses.
- Next.js, React, Tailwind, Zustand, TanStack Query, Radix UI and Lucide retain their upstream licenses. Dependency lockfiles record frontend package versions.
- `frontend/public/demo-*.svg` and `samples/japanese-page.png`: original geometric artwork created for this project, CC0 1.0. The Japanese sentence is a simple original test fixture. Homepage English lettering is an authored demonstration, not model output.

No copyrighted manga pages from publishers or unauthorized hosting services are bundled.

## Optional manga recognition

Manga OCR and the kha-white/manga-ocr-base weights are Apache-2.0: https://github.com/kha-white/manga-ocr and https://huggingface.co/kha-white/manga-ocr-base. The installer pins revision aa6573bd10b0d446cbf622e29c3e084914df9741 and verifies model SHA-256. PyTorch loads tensor weights in restricted weights-only mode. Dependencies include Transformers, Fugashi, UniDic Lite and Jaconv; their upstream licenses apply. User-supplied manga in samples/sora-wo-matotte-chapter-34 is local test material and is not covered by samples/LICENSE.txt.
