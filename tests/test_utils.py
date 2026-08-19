"""Testes dos utilitários compartilhados."""

from meeting_processor.utils import (
    ascii_slug,
    atomic_write_text,
    format_duration,
    format_timestamp,
    parse_timestamp,
)


def test_format_duration_formats_hms():
    assert format_duration(3661) == "01:01:01"


def test_format_timestamp_formats_mmss():
    assert format_timestamp(125) == "02:05"


def test_parse_timestamp_roundtrip():
    assert parse_timestamp("01:02:03.500") == 3723.5


def test_parse_timestamp_accepts_comma_decimal():
    assert parse_timestamp("00:00:01,250") == 1.25


def test_atomic_write_creates_file_and_content(tmp_path):
    target = tmp_path / "sub" / "nota.md"
    atomic_write_text(target, "conteudo")
    assert target.read_text(encoding="utf-8") == "conteudo"


def test_atomic_write_overwrites(tmp_path):
    target = tmp_path / "nota.md"
    atomic_write_text(target, "v1")
    atomic_write_text(target, "v2")
    assert target.read_text(encoding="utf-8") == "v2"


def test_atomic_write_leaves_no_tmp_files(tmp_path):
    target = tmp_path / "nota.md"
    atomic_write_text(target, "x")
    assert list(tmp_path.glob("*.tmp")) == []


def test_ascii_slug_remove_acentos():
    assert ascii_slug("Gravação de Tela às 10h") == "Gravacao_de_Tela_as_10h"


def test_ascii_slug_aceita_unicode_decomposto():
    """Gravações vindas do macOS chegam em NFD (a + combinando til)."""
    decomposto = "Gravação"
    assert ascii_slug(decomposto) == "Gravacao"


def test_ascii_slug_usa_fallback_quando_nada_sobra():
    assert ascii_slug("日本語", fallback="audio") == "audio"


def test_ascii_slug_preserva_ponto_e_hifen():
    assert ascii_slug("2026-08-19 as 10.18.33") == "2026-08-19_as_10.18.33"
