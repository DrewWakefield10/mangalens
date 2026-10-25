"""Small server-side DeepL client. Credentials never enter response bodies or logs."""

import time
import httpx
from .config import settings


TARGET_CODES = {
    "en": "EN-US",
    "pt": "PT-BR",
    "zh-CN": "ZH-HANS",
    "zh-TW": "ZH-HANT",
}
SOURCE_CODES = {"zh-CN": "ZH", "zh-TW": "ZH"}
RETRYABLE = {429, 500, 503, 504, 529}


class DeepLError(ValueError):
    def __init__(self, message, status_code=0):
        super().__init__(message)
        self.status_code = status_code


def base_url():
    if not settings.deepl_api_key:
        raise DeepLError("DeepL is not configured.")
    return "https://api-free.deepl.com" if settings.deepl_api_key.endswith(":fx") else "https://api.deepl.com"


def _headers():
    return {"Authorization": "DeepL-Auth-Key " + settings.deepl_api_key}


def account_usage():
    """Read-only, unbilled usage check; return only non-secret counters."""
    try:
        with httpx.Client(timeout=15, follow_redirects=False) as client:
            response = client.get(base_url() + "/v2/usage", headers=_headers())
        if response.status_code != 200:
            raise DeepLError("DeepL usage could not be checked.", response.status_code)
        data = response.json()
        return {
            "character_count": int(data["character_count"]),
            "character_limit": int(data["character_limit"]),
        }
    except (httpx.HTTPError, KeyError, TypeError, ValueError) as exc:
        if isinstance(exc, DeepLError):
            raise
        raise DeepLError("DeepL usage could not be checked.") from None


def translate_texts(texts, source, target, context="", glossary_id="", attempt_guard=None):
    if not texts or any(not text.strip() for text in texts):
        raise DeepLError("No text was provided for translation.")
    payload = {
        "text": texts,
        "target_lang": TARGET_CODES.get(target, target.upper()),
        "context": context[-4000:],
        "show_billed_characters": True,
    }
    if source != "auto":
        payload["source_lang"] = SOURCE_CODES.get(source, source.upper())
        if glossary_id:
            payload["glossary_id"] = glossary_id
    # DeepL returns each text in the same order, while context influences all.
    rate_limits = 0
    for attempt in range(4):
        event_id = attempt_guard[0]() if attempt_guard else None

        def settle(status, characters=None):
            if attempt_guard:
                attempt_guard[1](event_id, status, characters)

        try:
            with httpx.Client(timeout=45, follow_redirects=False) as client:
                response = client.post(
                    base_url() + "/v2/translate",
                    headers=_headers(),
                    json=payload,
                )
        except httpx.HTTPError:
            settle("uncertain")
            if attempt == 3:
                raise DeepLError("DeepL is temporarily unreachable. Retry this page.") from None
            time.sleep(2**attempt)
            continue
        if response.status_code != 200:
            settle("rate_limited" if response.status_code == 429 else "failed",
                   0 if response.status_code in (400, 403, 404, 413, 429, 456) else None)
        if response.status_code == 429:
            rate_limits += 1
        if response.status_code in RETRYABLE and attempt < 3:
            delay = response.headers.get("Retry-After", "")
            time.sleep(min(8, int(delay)) if delay.isdigit() else 2**attempt)
            continue
        if response.status_code == 403:
            raise DeepLError("DeepL rejected the API key or account permissions.", 403)
        if response.status_code == 456:
            raise DeepLError("DeepL character quota is exhausted. Check usage or select an authorized fallback.", 456)
        if response.status_code == 429:
            raise DeepLError("DeepL is rate-limiting requests. Retry later.", 429)
        if response.status_code != 200:
            raise DeepLError("DeepL could not translate this region. Check language support and retry.", response.status_code)
        try:
            data = response.json()["translations"]
            if len(data) != len(texts):
                raise ValueError()
            output = [entry["text"] for entry in data]
            if any(not isinstance(text, str) or not text.strip() for text in output):
                raise ValueError()
            billed = sum(
                    int(entry.get("billed_characters", len(source_text)))
                    for entry, source_text in zip(data, texts)
                )
            if billed < 0:
                raise ValueError()
            settle("completed", billed)
            return output, {
                "billed_characters": billed,
                "detected_languages": [entry.get("detected_source_language", "") for entry in data],
                "rate_limit_responses": rate_limits,
                "request_attempts": attempt + 1,
            }
        except (KeyError, TypeError, ValueError):
            settle("uncertain")
            raise DeepLError("DeepL returned an incomplete translation.") from None
    raise DeepLError("DeepL could not translate this region.")
