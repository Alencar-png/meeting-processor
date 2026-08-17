"""Testes do watcher: marcador de processado por assinatura de conteúdo."""

from meeting_processor.watcher import RecordingHandler


def _handler(tmp_path) -> RecordingHandler:
    h = RecordingHandler.__new__(RecordingHandler)
    h._processed_dir = tmp_path / ".processed"
    h._processed_dir.mkdir()
    return h


def test_unprocessed_file_returns_false(tmp_path):
    h = _handler(tmp_path)
    video = tmp_path / "reuniao.mp4"
    video.write_bytes(b"conteudo")
    assert h._is_already_processed(video) is False


def test_marked_file_is_processed(tmp_path):
    h = _handler(tmp_path)
    video = tmp_path / "reuniao.mp4"
    video.write_bytes(b"conteudo")
    h._mark_processed(video)
    assert h._is_already_processed(video) is True


def test_rewritten_file_same_name_is_reprocessed(tmp_path):
    h = _handler(tmp_path)
    video = tmp_path / "reuniao.mp4"
    video.write_bytes(b"conteudo original")
    h._mark_processed(video)
    # Regrava com conteúdo diferente (tamanho muda → assinatura muda).
    video.write_bytes(b"conteudo completamente novo e bem maior xxxxxxxxxx")
    assert h._is_already_processed(video) is False


def test_legacy_marker_without_signature_counts_as_processed(tmp_path):
    h = _handler(tmp_path)
    (h._processed_dir / "legado.mp4.done").write_text("processed_at=2026-01-01 00:00:00")
    video = tmp_path / "legado.mp4"
    video.write_bytes(b"x")
    assert h._is_already_processed(video) is True


def test_signature_changes_with_content(tmp_path):
    video = tmp_path / "v.mp4"
    video.write_bytes(b"aaa")
    sig1 = RecordingHandler._signature(video)
    video.write_bytes(b"aaaaaaaaaa")
    sig2 = RecordingHandler._signature(video)
    assert sig1 != sig2 and sig1 != ""
