"""Testes das partes do worker do Chatterbox que não precisam do modelo."""

from pathlib import Path

import pytest

from meeting_processor.tts_chatterbox import (
    MAX_CHUNK_CHARS,
    READY_LAYOUT,
    prepare_ready_dir,
    split_text,
)


def test_split_text_agrupa_sentencas_ate_o_limite():
    frases = ["Primeira frase curta.", "Segunda, também curta!", "Terceira?"]
    assert split_text(" ".join(frases), limit=45) == [
        "Primeira frase curta. Segunda, também curta!",
        "Terceira?",
    ]


def test_split_text_nao_corta_uma_sentenca_enorme():
    enorme = "palavra " * 80
    assert split_text(enorme.strip(), limit=50) == [enorme.strip()]


def test_split_text_vazio_e_espacos():
    assert split_text("") == []
    assert split_text("   \n  ") == []


def test_split_text_respeita_o_limite_padrao():
    texto = ". ".join(f"Frase número {i} com algum conteúdo" for i in range(30)) + "."
    partes = split_text(texto)
    assert len(partes) > 1
    assert all(len(p) <= MAX_CHUNK_CHARS for p in partes)
    assert " ".join(partes) == texto


def test_prepare_ready_dir_monta_os_nomes_que_a_biblioteca_espera(tmp_path: Path):
    for source in {"t3_pt_br.safetensors", "s3gen_v3.pt", "ve.pt", "grapheme_mtl_merged_expanded_v1.json"}:
        (tmp_path / source).write_bytes(b"x")
    # conds.pt e Cangjie são opcionais: faltam de propósito.

    ready = prepare_ready_dir(tmp_path)

    assert ready == tmp_path / "ready"
    assert (ready / "t3_mtl23ls_v3.safetensors").read_bytes() == b"x"
    assert (ready / "s3gen.pt").exists()
    assert (ready / "ve.pt").exists()
    assert not (ready / "conds.pt").exists()
    # Rodar de novo é inofensivo.
    assert prepare_ready_dir(tmp_path) == ready


def test_prepare_ready_dir_reclama_do_que_falta(tmp_path: Path):
    (tmp_path / "ve.pt").write_bytes(b"x")
    with pytest.raises(FileNotFoundError, match="t3_pt_br.safetensors"):
        prepare_ready_dir(tmp_path)


def test_layout_cobre_o_que_o_pack_entrega():
    assert READY_LAYOUT["t3_mtl23ls_v3.safetensors"] == "t3_pt_br.safetensors"
    assert READY_LAYOUT["s3gen.pt"] == "s3gen_v3.pt"
