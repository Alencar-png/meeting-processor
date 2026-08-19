"""Testes da extração de áudio (sem invocar o ffmpeg de verdade)."""

from pathlib import Path

from meeting_processor import audio as audio_mod


def test_wav_temporario_tem_nome_ascii(tmp_config, monkeypatch):
    """O whisper-cli no Windows não abre caminho acentuado; o temporário
    precisa sair em ASCII mesmo vindo de um nome com acentos."""
    monkeypatch.setattr(audio_mod, "validate_ffmpeg", lambda: True)

    chamadas: list[list[str]] = []

    def fake_run(cmd, **kwargs):
        chamadas.append(cmd)
        Path(cmd[-1]).write_bytes(b"RIFF")
        return None

    monkeypatch.setattr(audio_mod.subprocess, "run", fake_run)

    video = tmp_config.temp_path.parent / "Gravação de Tela às 10.18.33.mov"
    video.parent.mkdir(parents=True, exist_ok=True)
    video.write_bytes(b"fake")

    saida = audio_mod.extract_audio(video, tmp_config)

    assert saida.name.isascii(), saida.name
    assert "Gravacao_de_Tela_as_10.18.33" in saida.name
    assert saida.suffix == ".wav"


def test_nomes_diferentes_nao_colidem_apos_o_slug(tmp_config, monkeypatch):
    """Dois nomes que achatam para o mesmo slug precisam continuar
    distintos — quem garante isso é o hash do caminho completo."""
    monkeypatch.setattr(audio_mod, "validate_ffmpeg", lambda: True)
    monkeypatch.setattr(
        audio_mod.subprocess,
        "run",
        lambda cmd, **kw: Path(cmd[-1]).write_bytes(b"RIFF"),
    )

    base = tmp_config.temp_path.parent / "watch"
    base.mkdir(parents=True, exist_ok=True)
    a = base / "reunião.mov"
    b = base / "reuniao.mov"
    a.write_bytes(b"x")
    b.write_bytes(b"x")

    assert audio_mod.extract_audio(a, tmp_config) != audio_mod.extract_audio(b, tmp_config)
