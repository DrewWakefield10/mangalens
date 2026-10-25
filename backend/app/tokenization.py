"""Tokenizer adapters for the two published Argos package formats."""


class SentencePieceTokens:
    def __init__(self, model_path):
        from sentencepiece import SentencePieceProcessor

        self.processor = SentencePieceProcessor(model_file=str(model_path))

    def encode(self, text, out_type=str):
        return self.processor.encode(text, out_type=out_type)

    def decode(self, pieces):
        # Some Argos vocabularies retain a second level of whitespace markers.
        return self.processor.decode(pieces).replace("\u2581", " ").strip()


class MosesBPE:
    def __init__(self, model_path, source, target):
        from sacremoses import MosesPunctNormalizer, MosesTokenizer, MosesDetokenizer
        from subword_nmt.apply_bpe import BPE

        self.normalizer = MosesPunctNormalizer(lang=source)
        self.words = MosesTokenizer(lang=source)
        self.join_words = MosesDetokenizer(lang=target)
        with model_path.open(encoding="utf-8") as codes:
            self.encoder = BPE(codes)

    def encode(self, text, out_type=str):
        normalized_text = self.normalizer.normalize(text)
        word_tokens = self.words.tokenize(normalized_text)
        return self.encoder.segment_tokens(word_tokens)

    def decode(self, pieces):
        words = " ".join(pieces).replace("@@ ", "").split()
        return self.join_words.detokenize(words)


def load_tokenizer(folder, source, target):
    sp_path = folder / "sentencepiece.model"
    if sp_path.is_file():
        return SentencePieceTokens(sp_path)
    return MosesBPE(folder / "bpe.model", source, target)
