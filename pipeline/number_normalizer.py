"""Chuẩn hóa số từ Excel/Google Sheets theo quy ước Calida: 1,234.56.

File Google Sheet thường chứa ô số thực; các giá trị này đi qua không thay đổi.
Phần xử lý chuỗi giữ tương thích dữ liệu cũ dùng ``1.234,56`` để việc chuyển đổi
không làm hỏng lịch sử, nhưng mọi file mẫu và hướng dẫn mới đều dùng ``1,234.56``.
"""
from __future__ import annotations

import math
import numbers

import pandas as pd


# Các trường số trong schema. Những trường còn lại là định danh, ngày hoặc văn bản.
NUMERIC_COLUMNS = frozenset({
    "open", "high", "low", "close", "volume",
    "support_lo", "support_hi", "resist_lo", "resist_hi", "expected_lo", "expected_hi",
    "net_value", "chg_pct", "weight_pct",
    "buy_lo", "buy_hi", "target", "stop", "cost",
    "ytd_pct", "stock_pct", "cash_pct", "other_pct",
    "nav_bn", "vn_target", "severity",
})


def parse_number(value):
    """Trả về số hoặc NaN, ưu tiên dạng chuẩn 1,234.56.

    Chuỗi chỉ có dấu phẩy với 1–2 chữ số phía sau (``12,5``) được chấp nhận như
    dữ liệu Việt Nam cũ trong giai đoạn chuyển đổi. Chuỗi mới phải nhập ``12.5``.
    """
    if value is None or pd.isna(value):
        return math.nan
    if isinstance(value, bool):
        return math.nan
    if isinstance(value, numbers.Number):
        return float(value)

    text = str(value).strip().replace("\u00a0", "").replace(" ", "")
    if not text:
        return math.nan
    text = text.replace("−", "-").replace("–", "-")
    negative = text.startswith("(") and text.endswith(")")
    if negative:
        text = text[1:-1]
    text = text.replace("%", "")

    # Hai dấu: dấu xuất hiện sau cùng là dấu thập phân.
    if "." in text and "," in text:
        if text.rfind(".") > text.rfind(","):
            text = text.replace(",", "")             # 1,234.56
        else:
            text = text.replace(".", "").replace(",", ".")  # 1.234,56 cũ
    elif "," in text:
        parts = text.split(",")
        tail = parts[-1]
        grouped = len(parts) > 1 and all(len(part) == 3 for part in parts[1:])
        if grouped:
            text = "".join(parts)                       # 1,234 hoặc 1,234,567
        elif len(parts) == 2 and len(tail) in (1, 2):
            text = ".".join(parts)                       # 12,5 / 12,50 dữ liệu cũ
        else:
            return math.nan

    number = pd.to_numeric(text, errors="coerce")
    if pd.isna(number):
        return math.nan
    return -float(number) if negative else float(number)


def parse_number_series(values: pd.Series) -> pd.Series:
    """Chuẩn hóa một cột, giữ chỉ số của DataFrame nguồn."""
    return values.map(parse_number)


def normalize_numeric_columns(frame: pd.DataFrame) -> pd.DataFrame:
    """Chuẩn hóa các cột số có mặt trong DataFrame mà không đổi cột văn bản."""
    for column in NUMERIC_COLUMNS.intersection(frame.columns):
        frame[column] = parse_number_series(frame[column])
    return frame


def format_number(value, decimals: int = 2) -> str:
    """Định dạng hiển thị cố định: dấu phẩy hàng nghìn, dấu chấm thập phân."""
    number = parse_number(value)
    if math.isnan(number):
        return ""
    rendered = f"{number:,.{decimals}f}"
    return rendered.rstrip("0").rstrip(".") if decimals else rendered


def normalize_number_text(value) -> str:
    """Chuẩn hóa ô giá dạng một số hoặc một khoảng giá, giữ nguyên văn bản khác."""
    if value is None or pd.isna(value):
        return ""
    text = str(value).strip()
    if not text:
        return ""
    parts = text.split("–")
    if len(parts) in (1, 2):
        numbers_ = [format_number(part.strip()) for part in parts]
        if all(numbers_):
            return " – ".join(numbers_)
    return text
