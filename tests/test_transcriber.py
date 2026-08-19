"""Testes da transcrição: diagnóstico de erro do whisper.cpp."""

from meeting_processor.transcriber import summarize_cli_error

# stderr real do whisper.cpp: o relatório do device Vulkan vem antes do erro.
STDERR_VULKAN = "\n".join(
    [
        "ggml_vulkan: Found 1 Vulkan devices:",
        "ggml_vulkan: 0 = AMD Radeon RX 9060 XT (AMD proprietary driver) | uma: 0 | fp16: 1",
        r"error: input file not found 'C:\tmp\Gravacao.wav'",
        "error: no input files specified",
        "",
        "usage: whisper-cli.exe [options] file0 file1 ...",
    ]
)


def test_summarize_mostra_o_erro_e_nao_o_preambulo_da_gpu():
    resumo = summarize_cli_error(STDERR_VULKAN)
    assert "input file not found" in resumo
    assert "Vulkan devices" not in resumo


def test_summarize_cai_para_as_ultimas_linhas_sem_marcador_de_erro():
    resumo = summarize_cli_error("linha um\nlinha dois\nlinha tres\nlinha quatro")
    assert "linha quatro" in resumo
    assert "linha um" not in resumo


def test_summarize_com_stderr_vazio():
    assert summarize_cli_error("   \n  ") == "sem saída de erro"


def test_summarize_respeita_o_limite():
    resumo = summarize_cli_error("error: " + "x" * 500, limit=50)
    assert len(resumo) == 53  # 50 + "..."
    assert resumo.endswith("...")
