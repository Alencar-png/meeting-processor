"""Testes da exportação de transcrição para pasta avulsa (comando transcribe)."""

from __future__ import annotations

import pytest

from meeting_processor.transcript_export import export, safe_stem, to_markdown, to_txt


def test_safe_stem_remove_caracteres_invalidos():
    assert safe_stem('call: cliente | "2026".mp4') == "call- cliente - -2026-"


def test_safe_stem_descarta_o_diretorio_do_caminho():
    assert safe_stem(r"C:\Users\ana\Videos\reuniao.mkv") == "reuniao"
    assert safe_stem("/data/videos/reuniao.mkv") == "reuniao"


def test_safe_stem_usa_fallback_quando_nome_fica_vazio():
    assert safe_stem("///.mp4") == "transcricao"


def test_markdown_traz_timestamps_e_metadados(sample_transcript):
    md = to_markdown(sample_transcript, "reuniao", source_file="reuniao.mp4")

    assert md.startswith("# reuniao")
    assert "**Duracao:** 00:00:20" in md
    assert "**Arquivo:** reuniao.mp4" in md
    assert "**[00:00]** Bom dia a todos." in md
    assert "**[00:12]** A Ana fica responsavel pela API." in md


def test_txt_tem_so_o_texto(sample_transcript):
    txt = to_txt(sample_transcript)

    assert "[00:00]" not in txt
    assert txt.splitlines() == [
        "Bom dia a todos.",
        "Vamos falar do projeto.",
        "A Ana fica responsavel pela API.",
    ]


def test_export_cria_pasta_da_reuniao_com_md_e_txt(tmp_path, sample_transcript):
    written = export(sample_transcript, tmp_path / "saida", "reuniao.mp4", ["md", "txt"])

    pasta = tmp_path / "saida" / "reuniao"
    assert [p.parent for p in written] == [pasta, pasta]
    assert [p.name for p in written] == ["reuniao.md", "reuniao.txt"]
    assert all(p.exists() for p in written)
    assert "Bom dia a todos." in written[0].read_text(encoding="utf-8")


def test_export_nao_sobrescreve_reuniao_existente(tmp_path, sample_transcript):
    export(sample_transcript, tmp_path, "reuniao.mp4", ["md", "txt"])
    segunda = export(sample_transcript, tmp_path, "reuniao.mp4", ["md", "txt"])

    # A segunda reunião ganha pasta própria; a primeira fica intacta.
    assert segunda[0].parent.name == "reuniao (2)"
    assert [p.name for p in segunda] == ["reuniao (2).md", "reuniao (2).txt"]
    assert (tmp_path / "reuniao" / "reuniao.md").exists()


def test_export_cria_a_pasta_de_saida(tmp_path, sample_transcript):
    destino = tmp_path / "nova" / "pasta"

    export(sample_transcript, destino, "reuniao.mp4", ["txt"])

    assert (destino / "reuniao" / "reuniao.txt").exists()


def test_export_rejeita_formato_desconhecido(tmp_path, sample_transcript):
    with pytest.raises(ValueError, match="Formato não suportado"):
        export(sample_transcript, tmp_path, "reuniao.mp4", ["pdf"])
