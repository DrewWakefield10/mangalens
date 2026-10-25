import hashlib
import io
import re
import shutil
import warnings
import zipfile
from pathlib import Path
from PIL import Image, ImageOps
from .config import settings

FORMATS = {".png", ".jpg", ".jpeg", ".webp"}
Image.MAX_IMAGE_PIXELS = settings.max_pixels


def natural(value):
    return [int(p) if p.isdigit() else p.lower() for p in re.split(r"(\d+)", value)]


def directory(project_id):
    path = settings.data_dir / "projects" / project_id
    path.mkdir(parents=True, exist_ok=True)
    return path


def asset(project_id, page_id, kind="original"):
    return directory(project_id) / f"{page_id}.{kind}.png"


def decode(data):
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(data)) as im:
                if im.format not in {"JPEG", "PNG", "WEBP"}:
                    raise ValueError("Only JPEG, PNG and WebP images are supported.")
                if im.width * im.height > settings.max_pixels:
                    raise ValueError(
                        "Image exceeds the pixel limit; split the page before uploading."
                    )
                if getattr(im, "n_frames", 1) != 1:
                    raise ValueError("Animated images are unsupported.")
                im.load()
                return ImageOps.exif_transpose(im).convert("RGB")
    except (Image.DecompressionBombError, Image.DecompressionBombWarning) as e:
        raise ValueError("Image exceeds the pixel limit.") from e
    except (OSError, SyntaxError) as e:
        raise ValueError("Invalid or unsupported image.") from e


def unpack(name, data):
    suffix = Path(name).suffix.lower()
    if suffix in FORMATS:
        return [(Path(name).name, decode(data))]
    if suffix in {".zip", ".cbz"}:
        result = []
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                infos = [i for i in archive.infolist() if not i.is_dir()]
                if len(infos) > settings.max_pages:
                    raise ValueError("Archive has too many entries.")
                if (
                    sum(i.file_size for i in infos)
                    > settings.max_upload_mb * 1024**2 * 3
                ):
                    raise ValueError("Archive expands beyond the size limit.")
                for info in sorted(infos, key=lambda i: natural(i.filename)):
                    parts = info.filename.replace("\\", "/").split("/")
                    if (
                        ".." in parts
                        or info.filename.startswith(("/", "\\"))
                        or ":" in info.filename
                    ):
                        raise ValueError("Unsafe archive path.")
                    if info.flag_bits & 1:
                        raise ValueError("Encrypted archives are unsupported.")
                    if info.file_size / max(info.compress_size, 1) > 200:
                        raise ValueError("Suspicious archive compression ratio.")
                    if Path(info.filename).suffix.lower() in FORMATS:
                        result.append(
                            (Path(info.filename).name, decode(archive.read(info)))
                        )
                        if (
                            sum(im.width * im.height for _, im in result)
                            > settings.max_pixels * 4
                        ):
                            raise ValueError(
                                "Chapter exceeds decoded memory limit. Upload smaller batches."
                            )
        except zipfile.BadZipFile as e:
            raise ValueError("Invalid archive.") from e
        if not result:
            raise ValueError("Archive contains no supported images.")
        return result
    if suffix == ".pdf":
        import pypdfium2 as pdfium

        try:
            with pdfium.PdfDocument(data) as doc:
                if len(doc) > settings.max_pages:
                    raise ValueError("PDF contains too many pages.")
                result = []
                for index in range(len(doc)):
                    page = doc[index]
                    width, height = page.get_size()
                    if width * height * 4 > settings.max_pixels:
                        raise ValueError("PDF page exceeds pixel limit at 144 DPI.")
                    bitmap = page.render(scale=2)
                    result.append((f"{index+1:04}.png", bitmap.to_pil().convert("RGB")))
                    bitmap.close()
                    page.close()
                    if (
                        sum(im.width * im.height for _, im in result)
                        > settings.max_pixels * 4
                    ):
                        raise ValueError("PDF exceeds decoded memory limit.")
                return result
        except pdfium.PdfiumError as e:
            raise ValueError("Invalid, encrypted or unsupported PDF.") from e
    raise ValueError("Unsupported file. Use PNG, JPEG, WebP, ZIP, CBZ or PDF.")


def save_original(project_id, page_id, image):
    path = asset(project_id, page_id)
    image.save(path, format="PNG")
    thumb = image.copy()
    thumb.thumbnail((240, 340))
    thumb.save(asset(project_id, page_id, "thumbnail"))
    return hashlib.sha256(path.read_bytes()).hexdigest()


def remove_project(project_id):
    root = (settings.data_dir / "projects").resolve()
    target = (root / project_id).resolve()
    if target.parent != root:
        raise ValueError("Invalid project path")
    if target.exists():
        shutil.rmtree(target)
