"""Testes da limpeza de alucinações: o caso real da call do Genesis."""

from meeting_processor.cleanup import (
    clean_segments,
    collapse_repeats,
    drop_isolated_phantoms,
    normalize,
)
from meeting_processor.models import TranscriptSegment


def seg(start: float, text: str, end: float | None = None) -> TranscriptSegment:
    return TranscriptSegment(start=start, end=end if end is not None else start + 1.0, text=text)


def textos(segments):
    return [s.text for s in segments]


def test_normalize_ignora_caixa_acento_e_pontuacao():
    assert normalize("Tchau.") == "tchau"
    assert normalize("  Até  MAIS!! ") == "ate mais"
    assert normalize("Legendas pela comunidade Amara.org") == "legendas pela comunidade amara org"


def test_quinze_tchaus_seguidos_viram_um():
    # O caso real: sala esperando gente entrar, o Whisper preencheu o silêncio.
    tchaus = [seg(90 + i * 1.5, "Tchau.") for i in range(15)]
    segments = [seg(60, "E vamos lá."), *tchaus, seg(113, "Maravilha, pessoal, vou começar a gravação.")]

    limpo, removidos = collapse_repeats(segments)

    assert removidos == 14
    assert textos(limpo) == ["E vamos lá.", "Tchau.", "Maravilha, pessoal, vou começar a gravação."]
    # O único que ficou cobre o intervalo inteiro da série.
    assert limpo[1].start == 90
    assert limpo[1].end == tchaus[-1].end


def test_duas_repeticoes_sao_fala_real_e_ficam():
    segments = [seg(0, "Boa tarde."), seg(1, "Tudo bem?"), seg(2, "Tudo bem?"), seg(3, "Vamos lá.")]
    limpo, removidos = collapse_repeats(segments)
    assert removidos == 0
    assert textos(limpo) == textos(segments)


def test_repeticao_conta_mesmo_com_variacao_de_pontuacao():
    segments = [seg(0, "Tchau."), seg(1, "tchau"), seg(2, "Tchau!"), seg(3, "Beleza.")]
    limpo, removidos = collapse_repeats(segments)
    assert removidos == 2
    assert textos(limpo) == ["Tchau.", "Beleza."]


def test_obrigado_isolado_no_inicio_sai():
    # "Obrigado." no segundo zero, trinta segundos antes de alguém falar.
    segments = [seg(0, "Obrigado."), seg(30, "Olá, boa tarde, boa tarde."), seg(36, "Tudo bem, pessoal?")]
    limpo, removidos = drop_isolated_phantoms(segments)
    assert removidos == 1
    assert textos(limpo) == ["Olá, boa tarde, boa tarde.", "Tudo bem, pessoal?"]


def test_obrigado_no_meio_da_conversa_fica():
    segments = [seg(10, "Pode mandar por e-mail."), seg(11.5, "Obrigado."), seg(12.5, "Imagina.")]
    limpo, removidos = drop_isolated_phantoms(segments)
    assert removidos == 0
    assert textos(limpo) == textos(segments)


def test_frase_desconhecida_isolada_nao_e_tocada():
    segments = [seg(0, "Nossa, eu estou aqui."), seg(60, "E vamos lá.")]
    limpo, removidos = drop_isolated_phantoms(segments)
    assert removidos == 0
    assert len(limpo) == 2


def test_clean_segments_encadeia_as_regras_e_relata():
    tchaus = [seg(90 + i * 1.5, "Tchau.") for i in range(15)]
    segments = [
        seg(0, "Obrigado."),
        seg(30, "Olá, boa tarde."),
        seg(60, "E vamos lá."),
        *tchaus,
        seg(125, "Maravilha, pessoal."),
    ]

    limpo, relatorio = clean_segments(segments)

    # A série virou um "Tchau." isolado por mais de cinco segundos de cada lado — e saiu.
    assert textos(limpo) == ["Olá, boa tarde.", "E vamos lá.", "Maravilha, pessoal."]
    assert relatorio.repeats_removed == 14
    assert relatorio.phantoms_removed == 2
    assert relatorio.total == 16
    assert relatorio.describe() == "limpeza: 14 repetição(ões) e 2 frase(s)-fantasma removida(s)"


def test_transcricao_limpa_passa_intacta_e_sem_relato():
    segments = [seg(0, "Boa tarde."), seg(2, "Vamos começar."), seg(4, "Primeiro ponto.")]
    limpo, relatorio = clean_segments(segments)
    assert textos(limpo) == textos(segments)
    assert relatorio.total == 0
    assert relatorio.describe() == ""


def test_lista_vazia():
    limpo, relatorio = clean_segments([])
    assert limpo == []
    assert relatorio.total == 0
