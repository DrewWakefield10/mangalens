"""Optional local manga crop recognizer. Never downloads weights during a job."""

import os
from functools import lru_cache
from .config import settings


def available():
    import importlib.util

    return (
        settings.manga_ocr_enabled
        and importlib.util.find_spec("manga_ocr") is not None
        and (settings.model_dir / "manga-ocr" / "provenance.json").is_file()
        and any(
            (settings.model_dir / "manga-ocr" / name).is_file()
            for name in ("model.safetensors", "pytorch_model.bin")
        )
    )


@lru_cache(maxsize=1)
def model():
    os.environ["USE_TF"] = "0"
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TORCH_FORCE_WEIGHTS_ONLY_LOAD"] = "1"
    import torch
    from manga_ocr import MangaOcr

    torch.set_num_threads(2)
    return MangaOcr(str(settings.model_dir / "manga-ocr"), force_cpu=True)


def recognize_crop(image):
    import torch

    with torch.inference_mode():
        return model()(image)
