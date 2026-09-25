"""DNSE OpenAPI market-data client tối giản, chỉ đọc giá và không có quyền đặt lệnh."""
from __future__ import annotations

import base64
from datetime import datetime, timezone
import hashlib
import hmac
import json
from urllib.parse import quote
from uuid import uuid4

import requests


class DNSEMarketDataError(RuntimeError):
    """Lỗi nguồn giá DNSE đã được rút gọn để không lộ thông tin xác thực."""


def build_signature(secret: str, method: str, path: str, date_value: str, nonce: str) -> str:
    """Tạo chữ ký giống SDK chính thức: HMAC-SHA256 rồi Base64 + URL encode."""
    signing_string = (
        f"(request-target): {method.lower()} {path}\n"
        f"date: {date_value}\n"
        f"nonce: {nonce}"
    )
    digest = hmac.new(secret.encode("utf-8"), signing_string.encode("utf-8"), hashlib.sha256).digest()
    return quote(base64.b64encode(digest).decode("utf-8"), safe="")


def build_auth_headers(api_key: str, api_secret: str, method: str, path: str,
                       api_version: str, date_value: str | None = None,
                       nonce: str | None = None) -> dict[str, str]:
    date_value = date_value or datetime.now(timezone.utc).strftime("%a, %d %b %Y %H:%M:%S %z")
    nonce = nonce or uuid4().hex
    signature = build_signature(api_secret, method, path, date_value, nonce)
    signature_header = (
        f'Signature keyId="{api_key}",algorithm="hmac-sha256",'
        f'headers="(request-target) date",signature="{signature}",nonce="{nonce}"'
    )
    return {
        "Date": date_value,
        "X-Signature": signature_header,
        "x-api-key": api_key,
        "version": api_version,
        "Accept": "application/json",
    }


def _safe_error_detail(response) -> str:
    try:
        payload = response.json()
    except (ValueError, json.JSONDecodeError):
        return "phản hồi không hợp lệ"
    if not isinstance(payload, dict):
        return "phản hồi không hợp lệ"
    code = str(payload.get("code") or "").strip()
    message = str(payload.get("message") or payload.get("description") or "").strip()
    detail = " · ".join(part for part in (code, message) if part)
    return detail[:240] or "không có chi tiết"


class DNSEMarketDataClient:
    """Client read-only cho endpoint giá gần nhất của DNSE."""

    def __init__(self, api_key: str, api_secret: str,
                 base_url: str = "https://openapi.dnse.com.vn",
                 api_version: str = "2026-07-23", timeout: float = 15.0,
                 session=None):
        if not api_key.strip() or not api_secret.strip():
            raise ValueError("DNSE_API_KEY và DNSE_API_SECRET không được để trống")
        self.api_key = api_key.strip()
        self._api_secret = api_secret.strip()
        self.base_url = base_url.rstrip("/")
        self.api_version = api_version
        self.timeout = timeout
        self.session = session or requests.Session()

    def get_latest_trade(self, symbol: str, board_id: str = "G1"):
        symbol = str(symbol).strip().upper()
        path = f"/price/{symbol}/trades/latest"
        headers = build_auth_headers(
            self.api_key, self._api_secret, "GET", path, self.api_version,
        )
        try:
            response = self.session.get(
                f"{self.base_url}{path}", params={"boardId": board_id},
                headers=headers, timeout=self.timeout,
            )
        except requests.RequestException as exc:
            raise DNSEMarketDataError(f"không kết nối được DNSE ({exc.__class__.__name__})") from exc
        if response.status_code < 200 or response.status_code >= 300:
            raise DNSEMarketDataError(
                f"DNSE HTTP {response.status_code}: {_safe_error_detail(response)}"
            )
        try:
            return response.json()
        except ValueError as exc:
            raise DNSEMarketDataError("DNSE trả về dữ liệu không phải JSON") from exc
