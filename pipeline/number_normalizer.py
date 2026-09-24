"""Chuẩn hóa số từ Excel/Google Sheets theo quy ước Calida: 1,234.56.

File Google Sheet thường chứa ô số thực; các giá trị này đi qua không thay đổi.
Phần xử lý chuỗi giữ tương thích dữ liệu cũ dùng ``1.234,56`` và các cách hiển thị
Google Sheets Việt Nam như ``1.234.567`` hoặc ``1.234 tỷ``. Mọi file mẫu và hướng
dẫn mới vẫn dùng ``1,234.56``.
"""
from __future__ import annotations

import math
import numbers
import re

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


_DISPLAY_UNIT_SUFFIX = re.compile(r"(?i)(?:vnd|vnđ|đồng|đ|tỷ|ty|triệu|tr|bn|billion)$")


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

    text = str(value).strip().replace("\u00a0", "").replace("\u202f", "").replace(" ", "")
    if not text:
        return math.nan
    text = text.replace("−", "-").replace("–", "-")
    negative = text.startswith("(") and text.endswith(")")
    if negative:
        text = text[1:-1]
    text = text.replace("%", "").replace("'", "")
    # Người dùng hay thêm đơn vị ngay trong ô, ví dụ ``1.234 tỷ``. Đơn vị này
    # không làm thay đổi cơ sở đo vì từng cột schema đã quy định đơn vị riêng.
    without_unit = _DISPLAY_UNIT_SUFFIX.sub("", text)
    has_display_unit = without_unit != text
    text = without_unit.rstrip(".")
    if not text:
        return math.nan

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
    elif text.count(".") > 1 or (has_display_unit and text.count(".") == 1):
        # Google Sheets ở locale Việt Nam có thể xuất số nguyên nhóm nghìn là
        # 1.234.567 (không có dấu phẩy thập phân). Dạng này không được pandas
        # hiểu trực tiếp, nên chỉ bỏ dấu chấm khi tất cả nhóm sau có 3 chữ số.
        sign, grouped_text = (text[0], text[1:]) if text[:1] in {"+", "-"} else ("", text)
        parts = grouped_text.split(".")
        if all(part.isdigit() for part in parts) and all(len(part) == 3 for part in parts[1:]):
            text = sign + "".join(parts)
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
