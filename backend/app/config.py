from pathlib import Path
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=ROOT / ".env", extra="ignore")
    database_url: str = "sqlite:///" + (ROOT / "data/mangalens.db").as_posix()
    data_dir: Path = ROOT / "data"
    model_dir: Path = ROOT / "models"
    font_path: Path = ROOT / "assets/fonts/NotoSansCJKjp-Regular.otf"
    cookie_secure: bool = False
    allowed_origin: str = "http://localhost:3000"
    max_upload_mb: int = 64
    max_pages: int = 100
    max_pixels: int = 24_000_000
    retention_days: int = 7
    job_timeout: int = 1800
    session_days: int = 30
    translation_provider: str = "deepl"
    fallback_provider: str = ""
    openai_base_url: str = "https://api.openai.com/v1"
    openai_api_key: str = ""
    openai_model: str = ""
    ollama_url: str = "http://localhost:11434"
    ollama_model: str = ""
    deepl_api_key: str = ""
    deepl_url: str = "https://api-free.deepl.com/v2/translate"
    deepl_glossary_id: str = ""
    deepl_monthly_character_budget: int = 100000
    google_api_key: str = ""
    azure_translator_key: str = ""
    azure_translator_region: str = ""
    azure_translator_endpoint: str = "https://api.cognitive.microsofttranslator.com"
    google_vision_api_key: str = ""
    cloud_ocr_monthly_request_budget: int = 100
    cloud_ocr_provider: str = "ocr_space"
    ocr_space_api_key: str = ""
    ocr_space_daily_request_budget: int = 50
    ocr_space_monthly_request_budget: int = 400
    ocr_space_engine3_monthly_budget: int = 300
    ocr_space_page_request_budget: int = 12
    ocr_space_engine3_fallback: bool = True
    ocr_min_confidence: float = Field(default=0.7, ge=0, le=1)
    ocr_min_agreement: float = Field(default=0.85, ge=0, le=1)
    authorized_source_hosts: str = ""
    max_translation_chars: int = 30000
    tesseract_cmd: str = ""
    manga_ocr_enabled: bool = True


settings = Settings()
settings.data_dir.mkdir(parents=True, exist_ok=True)
