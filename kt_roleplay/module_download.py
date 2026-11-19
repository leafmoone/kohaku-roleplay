"""Fetch one reviewed JavaScript module without a proxy, redirect, or second DNS lookup."""

from http.client import HTTPException, HTTPSConnection
from ipaddress import ip_address
import socket
import ssl
from time import monotonic
from urllib.parse import quote, urlsplit

from .errors import CardError

MAX_MODULE_BYTES = 1024 * 1024
_DOWNLOAD_SECONDS = 6
_PLAIN_MEDIA = frozenset({"application/javascript", "application/ecmascript", "text/javascript",
                          "text/ecmascript", "text/plain"})


class _ModuleConnection(HTTPSConnection):
    def __init__(self, hostname: str, ip: str) -> None:
        self._approved_ip = ip
        self._tls = ssl.create_default_context()
        super().__init__(hostname, 443, timeout=_DOWNLOAD_SECONDS, context=self._tls)

    def connect(self) -> None:
        raw = socket.create_connection((self._approved_ip, 443), timeout=self.timeout)
        try:
            self.sock = self._tls.wrap_socket(raw, server_hostname=self.host)
        except OSError:
            raw.close()
            raise


def _https_target(url: str, kind: str) -> tuple[str, str]:
    try:
        if not 0 < len(url) <= 2048 or "\\" in url or any(char.isspace() or ord(char) < 32 for char in url):
            raise ValueError
        parts = urlsplit(url)
        if (parts.scheme != "https" or not parts.hostname or parts.port not in (443, None)
                or parts.username is not None or parts.password is not None or parts.fragment):
            raise ValueError
        hostname = parts.hostname.encode("idna").decode("ascii")
        resource = quote(parts.path or "/", safe="/%:@!$&'()*+,;=-._~")
        if parts.query:
            resource += "?" + quote(parts.query, safe="/?%:@!$&'()*+,;=-._~")
        return hostname, resource
    except (ValueError, UnicodeError) as exc:
        raise CardError(f"{kind} sources must use HTTPS on port 443 without credentials or fragments") from exc


def _module_target(url: str) -> tuple[str, str]:
    return _https_target(url, "Module")


def opening_html_target(url: str) -> tuple[str, str]:
    hostname, resource = _https_target(url, "Opening page")
    # Browser URL parsing collapses literal and percent-encoded dot segments.
    # Refuse them rather than caching a potentially different HTTP resource.
    if any(part.lower().replace("%2e", ".") in (".", "..") for part in resource.partition("?")[0].split("/")):
        raise CardError("Opening page sources must not contain dot segments in the path")
    return hostname, resource


def _public_ip(hostname: str, kind: str) -> str:
    try:
        addresses = socket.getaddrinfo(hostname, 443, type=socket.SOCK_STREAM, proto=socket.IPPROTO_TCP)
    except socket.gaierror as exc:
        raise CardError(f"{kind} source hostname did not resolve: {hostname}") from exc
    ips = [ip_address(row[4][0]) for row in addresses]
    if not ips or any(not ip.is_global or ip.is_multicast or (ip.version == 6 and (ip.is_site_local or ip.scope_id))
                      for ip in ips):
        raise CardError(f"{kind} source must resolve only to public internet addresses: {hostname}")
    # Connect to the checked address, but verify TLS for the original hostname.
    return str(ips[0])


def _download_text(hostname: str, resource: str, *, kind: str, accept: str, media_types: frozenset[str],
                   max_bytes: int, size_label: str, format_label: str) -> bytes:
    connection = _ModuleConnection(hostname, _public_ip(hostname, kind.capitalize()))
    started = monotonic()
    try:
        connection.request("GET", resource, headers={"Accept": accept,
                                                   "Accept-Encoding": "identity", "Connection": "close"})
        with connection.getresponse() as response:
            if response.status != 200:
                raise CardError(f"{kind.capitalize()} source {hostname} returned HTTP {response.status}; redirects are not followed")
            encoding = response.getheader("Content-Encoding", "identity").lower().strip()
            media = response.getheader("Content-Type", "").split(";", 1)[0].strip().lower()
            if encoding != "identity" or media not in media_types:
                raise CardError(f"The {kind} response must be uncompressed {format_label}")
            expected_size = response.length
            if expected_size is not None and expected_size > max_bytes:
                raise CardError(f"The {kind} exceeded the {size_label} download limit")
            content = bytearray()
            while chunk := response.read1(65536):
                content += chunk
                if len(content) > max_bytes:
                    raise CardError(f"The {kind} exceeded the {size_label} download limit")
                if monotonic() - started >= _DOWNLOAD_SECONDS:
                    raise CardError(f"The {kind} download timed out")
            if expected_size is not None and len(content) != expected_size:
                raise CardError(f"The {kind} download ended before its declared length")
    except (OSError, HTTPException) as exc:
        raise CardError(f"Could not download {kind} from {hostname}") from exc
    finally:
        connection.close()
    if not content:
        raise CardError(f"The {kind} source returned an empty file")
    try:
        content.decode("utf-8-sig")
    except UnicodeError as exc:
        raise CardError(f"The {kind} source is not UTF-8 {format_label}") from exc
    return bytes(content)


def download_module(url: str) -> bytes:
    return _download_text(*_module_target(url), kind="module", accept="text/javascript, application/javascript, text/plain",
                          media_types=_PLAIN_MEDIA, max_bytes=MAX_MODULE_BYTES, size_label="1 MiB",
                          format_label="JavaScript or plain text")


def download_opening_html(url: str, max_bytes: int) -> bytes:
    return _download_text(*opening_html_target(url), kind="opening page", accept="text/html",
                          media_types=frozenset({"text/html"}), max_bytes=max_bytes,
                          size_label=f"{max_bytes // 1024} KiB", format_label="HTML")
