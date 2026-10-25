"""Opt-in public HTTPS JSON manifests. No scraping or authentication bypass."""

import http.client
import ipaddress
import json
import socket
import ssl
from urllib.parse import urlsplit, urljoin
from .config import settings


class PinnedHTTPS(http.client.HTTPSConnection):
    def __init__(self, hostname, address):
        super().__init__(hostname, timeout=20, context=ssl.create_default_context())
        self.address = address

    def connect(self):
        sock = socket.create_connection((self.address, 443), self.timeout)
        self.sock = self._context.wrap_socket(sock, server_hostname=self.host)


def validate_url(url):
    parsed = urlsplit(url)
    allowed = {
        h.strip().lower()
        for h in settings.authorized_source_hosts.split(",")
        if h.strip()
    }
    if (
        parsed.scheme != "https"
        or parsed.username
        or parsed.password
        or parsed.port not in (None, 443)
    ):
        raise ValueError(
            "Sources must use public HTTPS on port 443 without credentials."
        )
    if not parsed.hostname or parsed.hostname.lower() not in allowed:
        raise ValueError(
            "This source is not authorized. Upload files you have permission to translate, or configure an authorized manifest host."
        )
    addresses = {
        item[4][0]
        for item in socket.getaddrinfo(parsed.hostname, 443, type=socket.SOCK_STREAM)
    }
    if not addresses or any(not ipaddress.ip_address(ip).is_global for ip in addresses):
        raise ValueError("Private and non-public network addresses are blocked.")
    return parsed, sorted(addresses)[0]


def download(url, limit, accepted, redirects=0):
    if redirects > 3:
        raise ValueError("Too many source redirects.")
    parsed, address = validate_url(url)
    connection = PinnedHTTPS(parsed.hostname, address)
    try:
        connection.request(
            "GET",
            parsed.path + ("?" + parsed.query if parsed.query else ""),
            headers={"User-Agent": "MangaLens/0.1 authorized-manifest-importer"},
        )
        response = connection.getresponse()
        if response.status in (301, 302, 303, 307, 308):
            return download(
                urljoin(url, response.getheader("Location", "")),
                limit,
                accepted,
                redirects + 1,
            )
        if response.status != 200:
            raise ValueError(
                f"Source returned HTTP {response.status}; access restrictions will not be bypassed."
            )
        content_type = response.getheader("Content-Type", "").split(";")[0].lower()
        if content_type not in accepted:
            raise ValueError("Unexpected remote content type.")
        content = response.read(limit + 1)
        if len(content) > limit:
            raise ValueError("Remote resource exceeds download limit.")
        return content
    finally:
        connection.close()


def import_manifest(url):
    manifest = json.loads(download(url, 256_000, {"application/json"}))
    pages = manifest.get("pages", [])
    if not isinstance(pages, list) or not 1 <= len(pages) <= settings.max_pages:
        raise ValueError(
            "Manifest needs an ordered, nonempty pages array within page limits."
        )
    if not all(isinstance(p, str) for p in pages):
        raise ValueError("Manifest pages must be image URLs.")
    files, total = [], 0
    for index, page in enumerate(pages):
        data = download(
            urljoin(url, page),
            settings.max_upload_mb * 1024**2,
            {"image/jpeg", "image/png", "image/webp"},
        )
        total += len(data)
        if total > settings.max_upload_mb * 1024**2:
            raise ValueError("Chapter exceeds download limit.")
        files.append((f"{index+1:04}.png", data))
    return str(manifest.get("title", "Imported chapter"))[:200], files
