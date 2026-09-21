from __future__ import annotations

import ipaddress
import socket
from html.parser import HTMLParser
from urllib.parse import urljoin, urlsplit

import httpx


class _PageText(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.parts: list[str] = []
        self.skip = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in {"script", "style", "svg"}:
            self.skip += 1
        if not self.skip and tag in {"p", "div", "br", "li", "h1", "h2", "h3", "tr"}:
            self.parts.append("\n")
        if not self.skip and tag == "a":
            href = dict(attrs).get("href")
            if href and href.startswith(("http://", "https://", "/")):
                self.parts.append(f" [link: {href}] ")

    def handle_endtag(self, tag: str) -> None:
        if tag in {"script", "style", "svg"} and self.skip:
            self.skip -= 1

    def handle_data(self, data: str) -> None:
        if not self.skip:
            self.parts.append(data)


def _validate_public_url(url: str) -> None:
    parsed = urlsplit(url)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("Only public HTTPS pages can be fetched.")
    if parsed.port not in {None, 443}:
        raise ValueError("Only public HTTPS pages on port 443 can be fetched.")
    host = parsed.hostname
    if host == "localhost" or host.endswith(".localhost") or host.endswith(".local"):
        raise ValueError("Local addresses cannot be fetched.")
    try:
        addresses = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise ValueError("Could not resolve that host.") from exc
    if not addresses or any(
        not ipaddress.ip_address(address[4][0]).is_global for address in addresses
    ):
        raise ValueError("Private or local addresses cannot be fetched.")


def fetch_public_page(url: str, query: str | None = None) -> tuple[str, str, bool]:
    for _ in range(4):
        _validate_public_url(url)
        try:
            with httpx.stream("GET", url, timeout=10, follow_redirects=False, trust_env=False) as response:
                if response.status_code in {301, 302, 303, 307, 308}:
                    location = response.headers.get("location")
                    if not location:
                        raise ValueError("The page redirected without a destination.")
                    url = urljoin(url, location)
                    continue
                if response.status_code >= 400:
                    raise ValueError(f"The page returned HTTP {response.status_code}.")
                content_type = response.headers.get("content-type", "").split(";", 1)[0].strip()
                if content_type not in {"text/html", "text/plain", "text/markdown", "application/json"}:
                    raise ValueError("The page is not readable text.")
                data = bytearray()
                for chunk in response.iter_bytes():
                    data.extend(chunk)
                    if len(data) >= 256_000:
                        break
        except httpx.RequestError as exc:
            raise ValueError("Could not retrieve that page.") from exc

        content = data.decode("utf-8", errors="replace")
        if content_type == "text/html":
            parser = _PageText()
            parser.feed(content)
            content = " ".join(" ".join(parser.parts).split())
        if query:
            needle = query.casefold()[:100]
            searchable = content.casefold()
            excerpts: list[str] = []
            offset = 0
            while len(excerpts) < 12:
                index = searchable.find(needle, offset)
                if index < 0:
                    break
                excerpts.append(content[max(0, index - 350) : index + len(needle) + 650])
                offset = index + len(needle)
            content = "\n\n...\n\n".join(excerpts) if excerpts else f"No matches for {query!r}. Page begins:\n{content[:4_000]}"
        truncated = len(content) > 16_000 or len(data) >= 256_000
        return url, content[:16_000], truncated
    raise ValueError("The page redirected too many times.")
