"""Resumo de reuniões via LLM (Claude, OpenAI, Gemini ou Ollama local).

Este módulo expõe:

- ``MeetingSummarizer``: factory pública. Retorna o provedor correto
  com base em ``config.llm_provider`` (``anthropic``, ``openai``,
  ``gemini`` ou ``local``).
- ``AnthropicSummarizer``: Claude API.
- ``OpenAISummarizer``: OpenAI e qualquer serviço compatível (OpenRouter,
  Groq, DeepSeek, xAI, Azure...) via ``openai_base_url``.
- ``GeminiSummarizer``: Google Gemini (API nativa).
- ``OllamaSummarizer``: servidor Ollama local.

Todos os provedores compartilham o mesmo system prompt e a mesma rotina de
parsing, então a saída é sempre um ``MeetingSummary`` com o mesmo formato.
"""

from __future__ import annotations

import json
import logging
import re
import time
from typing import Protocol

import anthropic
import httpx

from .config import Settings
from .models import (
    ActionItem,
    MeetingSummary,
    TimeWindowSummary,
    Transcript,
    TranscriptSegment,
)
from .utils import format_duration, format_timestamp

logger = logging.getLogger(__name__)


class SummaryParseError(RuntimeError):
    """Resposta do LLM não continha JSON válido/parseável.

    Levantada (em vez de retornar um resumo vazio silencioso) para que o
    pipeline trate como falha real: a reunião NÃO é marcada como processada
    e pode ser reprocessada. Antes, um JSON truncado virava sucesso com
    resumo vazio e a reunião era perdida silenciosamente.
    """


SYSTEM_PROMPT = """\
Você é um assistente especializado em resumir reuniões transcritas em português brasileiro.
Seu foco PRINCIPAL é produzir um RESUMO RICO E DETALHADO da reunião — uma ata completa
que permita a alguém que não participou entender tudo o que foi discutido, decidido e
concluído. As tarefas são uma saída SECUNDÁRIA: extraia-as apenas se realmente existirem.

Analise a transcrição e produza uma análise estruturada em JSON.

Responda APENAS com JSON válido, sem markdown, sem blocos de código. O JSON deve seguir esta estrutura exata:

{
  "executive_summary": "Resumo executivo em 1 parágrafo denso (4 a 6 frases) com o panorama geral, os assuntos centrais e as conclusões da reunião.",
  "detailed_summary": "Resumo DETALHADO e narrativo, em VÁRIOS parágrafos separados por linhas em branco. Cubra em profundidade: o contexto e o objetivo da reunião; cada assunto discutido, com os argumentos, pontos de vista e problemas levantados; o encadeamento da conversa; e as conclusões. Escreva de forma fluida e completa, como uma ata detalhada. NÃO seja econômico — este é o conteúdo mais importante.",
  "decisions": ["Cada decisão concreta tomada na reunião, uma por item"],
  "time_windows": [
    {
      "start_minutes": 0,
      "end_minutes": 5,
      "summary": "Resumo detalhado do que foi discutido neste período, com contexto suficiente para ser útil isoladamente."
    }
  ],
  "action_items": [
    {
      "description": "Descrição clara da tarefa",
      "assignee": "Nome do responsável ou null",
      "priority": "alta/média/baixa ou null",
      "due_date": "Prazo mencionado ou null",
      "source_timestamp": "MM:SS aproximado de quando foi mencionada"
    }
  ],
  "participants": ["Nome1", "Nome2"],
  "key_topics": ["Tópico 1", "Tópico 2"]
}

Regras:
- PRIORIZE os campos "executive_summary" e "detailed_summary" — eles são o objetivo central.
- O "detailed_summary" deve ter substância real: prefira ser completo a ser breve.
- Cada time_window cobre um bloco de {chunk_minutes} minutos e deve ser informativo.
- Liste em "decisions" apenas decisões efetivamente tomadas (vazio se não houver).
- Em "action_items", extraia apenas tarefas/compromissos reais e explícitos. Não invente
  tarefas para "preencher": se a reunião não gerou tarefas, retorne lista vazia.
- Se não conseguir identificar participantes pelo nome, use "Participante 1", etc.
- Tópicos principais devem ser 3-6 temas centrais discutidos.\
"""


# ---------------------------------------------------------------------------
# Interface
# ---------------------------------------------------------------------------


class SummarizerProtocol(Protocol):
    """Interface comum entre os provedores de LLM."""

    def summarize(self, transcript: Transcript, source_filename: str) -> MeetingSummary:
        ...


# ---------------------------------------------------------------------------
# Base com lógica compartilhada
# ---------------------------------------------------------------------------


class _BaseSummarizer:
    """Implementa a montagem do prompt e o parsing do JSON.

    Subclasses devem implementar ``_call_llm(system_prompt, user_prompt)``
    retornando uma string com a resposta do modelo.
    """

    provider_name: str = "base"

    def __init__(self, config: Settings):
        self.config = config

    # API pública -----------------------------------------------------------

    def summarize(self, transcript: Transcript, source_filename: str) -> MeetingSummary:
        chunked_text = self._build_chunked_transcript(
            transcript.segments,
            self.config.summary_chunk_minutes,
        )

        # Reuniões curtas: 1 chamada (mais barato, sem perda de contexto).
        # Reuniões longas: map-reduce, para não truncar nem estourar o contexto.
        threshold = self.config.summary_map_reduce_threshold_chars
        if len(chunked_text) <= threshold:
            summary = self._summarize_single(chunked_text, source_filename, transcript)
        else:
            logger.info(
                "Transcrição longa (%d chars > %d) — resumindo por map-reduce.",
                len(chunked_text), threshold,
            )
            summary = self._summarize_map_reduce(transcript, source_filename)

        logger.info(
            "Resumo gerado (%s): %d janelas, %d tarefas, %d participantes.",
            self.provider_name,
            len(summary.time_windows),
            len(summary.action_items),
            len(summary.participants),
        )
        return summary

    def _summarize_single(
        self, chunked_text: str, source_filename: str, transcript: Transcript
    ) -> MeetingSummary:
        user_prompt = (
            f"Arquivo de origem: {source_filename}\n"
            f"Duração total: {format_duration(transcript.duration)}\n\n"
            f"--- TRANSCRIÇÃO ---\n\n{chunked_text}"
        )
        system_prompt = SYSTEM_PROMPT.replace(
            "{chunk_minutes}", str(self.config.summary_chunk_minutes)
        )
        logger.info(
            "Enviando transcrição ao provedor '%s' para resumo...", self.provider_name
        )
        return self._parse_response(self._call_llm(system_prompt, user_prompt))

    def _summarize_map_reduce(
        self, transcript: Transcript, source_filename: str
    ) -> MeetingSummary:
        blocks = self._split_segments(
            transcript.segments,
            self.config.summary_map_reduce_chunk_chars,
            self.config.summary_chunk_minutes,
        )
        system_prompt = SYSTEM_PROMPT.replace(
            "{chunk_minutes}", str(self.config.summary_chunk_minutes)
        )
        partials: list[MeetingSummary] = []
        for i, block_text in enumerate(blocks, start=1):
            logger.info("Map-reduce: resumindo bloco %d/%d...", i, len(blocks))
            user_prompt = (
                f"Arquivo de origem: {source_filename} (parte {i}/{len(blocks)})\n"
                f"Duração total: {format_duration(transcript.duration)}\n\n"
                f"Este é um TRECHO da reunião. Resuma apenas o que aparece aqui.\n\n"
                f"--- TRANSCRIÇÃO (parcial) ---\n\n{block_text}"
            )
            # Resiliência: se um bloco isolado falhar (ex.: JSON truncado), não
            # perde a reunião inteira — ignora esse trecho e segue com o resto.
            try:
                partials.append(self._parse_response(self._call_llm(system_prompt, user_prompt)))
            except SummaryParseError:
                logger.warning("Bloco %d/%d não parseou; ignorando esse trecho.", i, len(blocks))
        if not partials:
            raise SummaryParseError("Nenhum trecho da reunião pôde ser resumido.")
        return self._merge_partials(partials)

    def _split_segments(
        self,
        segments: list[TranscriptSegment],
        max_chars: int,
        chunk_minutes: int,
    ) -> list[str]:
        """Divide os segmentos em blocos de ~``max_chars`` para o map-reduce."""
        if not segments:
            return ["(Transcrição vazia)"]

        blocks: list[str] = []
        current: list[TranscriptSegment] = []
        current_len = 0
        for seg in segments:
            seg_len = len(seg.text) + 20  # ~timestamp + indentação
            if current and current_len + seg_len > max_chars:
                blocks.append(self._build_chunked_transcript(current, chunk_minutes))
                current = []
                current_len = 0
            current.append(seg)
            current_len += seg_len
        if current:
            blocks.append(self._build_chunked_transcript(current, chunk_minutes))
        return blocks

    @staticmethod
    def _merge_partials(partials: list[MeetingSummary]) -> MeetingSummary:
        """Consolida resumos parciais (map-reduce) num único ``MeetingSummary``.

        Reduce puramente programático (sem chamada extra de LLM): concatena
        janelas e tarefas, une participantes/tópicos sem duplicar, e junta os
        resumos executivos de cada trecho.
        """
        exec_parts: list[str] = []
        detailed_parts: list[str] = []
        decisions: list[str] = []
        time_windows: list[TimeWindowSummary] = []
        action_items: list[ActionItem] = []
        participants: list[str] = []
        key_topics: list[str] = []
        seen_p: set[str] = set()
        seen_t: set[str] = set()
        seen_d: set[str] = set()

        for p in partials:
            if p.executive_summary.strip():
                exec_parts.append(p.executive_summary.strip())
            if p.detailed_summary.strip():
                detailed_parts.append(p.detailed_summary.strip())
            time_windows.extend(p.time_windows)
            action_items.extend(p.action_items)
            for decision in p.decisions:
                key = decision.strip().lower()
                if key and key not in seen_d:
                    seen_d.add(key)
                    decisions.append(decision)
            for name in p.participants:
                key = name.strip().lower()
                if key and key not in seen_p:
                    seen_p.add(key)
                    participants.append(name)
            for topic in p.key_topics:
                key = topic.strip().lower()
                if key and key not in seen_t:
                    seen_t.add(key)
                    key_topics.append(topic)

        return MeetingSummary(
            executive_summary="\n\n".join(exec_parts),
            detailed_summary="\n\n".join(detailed_parts),
            decisions=decisions,
            time_windows=time_windows,
            action_items=action_items,
            participants=participants,
            key_topics=key_topics,
        )

    # Hook que cada provedor implementa -----------------------------------

    def _call_llm(self, system_prompt: str, user_prompt: str) -> str:
        raise NotImplementedError

    # Helpers compartilhados ----------------------------------------------

    def _build_chunked_transcript(
        self,
        segments: list[TranscriptSegment],
        chunk_minutes: int,
    ) -> str:
        if not segments:
            return "(Transcrição vazia)"

        lines: list[str] = []
        current_chunk_start = 0
        chunk_seconds = chunk_minutes * 60

        for seg in segments:
            chunk_index = int(seg.start // chunk_seconds)
            chunk_start = chunk_index * chunk_minutes
            chunk_end = chunk_start + chunk_minutes

            if chunk_start != current_chunk_start or seg is segments[0]:
                current_chunk_start = chunk_start
                lines.append(f"\n[{chunk_start:02d}:00 - {chunk_end:02d}:00]")

            timestamp = format_timestamp(seg.start)
            lines.append(f"  [{timestamp}] {seg.text}")

        return "\n".join(lines)

    def _parse_response(self, response_text: str) -> MeetingSummary:
        cleaned = response_text.strip()
        cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned)
        cleaned = re.sub(r"\s*```$", "", cleaned)

        # strict=False tolera caracteres de controle (quebras de linha literais)
        # dentro das strings — comum quando o resumo detalhado tem vários
        # parágrafos e o modelo não escapa os \n.
        # Modelos locais às vezes adicionam texto antes/depois do JSON: se o
        # parse direto falhar, tenta extrair o primeiro objeto {...}.
        try:
            data = json.loads(cleaned, strict=False)
        except json.JSONDecodeError:
            match = re.search(r"\{.*\}", cleaned, re.DOTALL)
            if match:
                try:
                    data = json.loads(match.group(0), strict=False)
                except json.JSONDecodeError as e:
                    logger.error("Resposta do LLM não é JSON válido: %s", e)
                    logger.debug("Resposta bruta: %s", response_text[:500])
                    raise SummaryParseError(
                        "Resposta do LLM não é JSON válido "
                        "(possível truncamento por max_tokens ou contexto)."
                    ) from e
            else:
                logger.error("Não foi possível extrair JSON da resposta do LLM.")
                logger.debug("Resposta bruta: %s", response_text[:500])
                raise SummaryParseError(
                    "Não foi possível extrair JSON da resposta do LLM."
                ) from None

        return MeetingSummary(
            executive_summary=data.get("executive_summary", ""),
            detailed_summary=data.get("detailed_summary", ""),
            decisions=data.get("decisions", []),
            time_windows=[
                TimeWindowSummary(**tw) for tw in data.get("time_windows", [])
            ],
            action_items=[ActionItem(**ai) for ai in data.get("action_items", [])],
            participants=data.get("participants", []),
            key_topics=data.get("key_topics", []),
        )


# ---------------------------------------------------------------------------
# Provedor: Claude (Anthropic API)
# ---------------------------------------------------------------------------


class AnthropicSummarizer(_BaseSummarizer):
    """Resume reuniões usando a Claude API."""

    provider_name = "anthropic"

    def __init__(self, config: Settings):
        super().__init__(config)
        if not config.anthropic_api_key:
            raise RuntimeError(
                "ANTHROPIC_API_KEY não definido. Configure no .env ou troque "
                "o provedor para 'local' (export MEETING_LLM_PROVIDER=local)."
            )
        self.client = anthropic.Anthropic(api_key=config.anthropic_api_key)

    # Erros transitórios que justificam retry com backoff. Diferente do
    # comportamento antigo (só RateLimitError), inclui falhas de conexão,
    # timeout e erros 5xx/overloaded da API.
    _RETRYABLE = (
        anthropic.RateLimitError,
        anthropic.APIConnectionError,
        anthropic.APITimeoutError,
        anthropic.InternalServerError,
    )

    def _call_llm(self, system_prompt: str, user_prompt: str, retries: int = 3) -> str:
        last_err: Exception | None = None
        for attempt in range(retries):
            try:
                message = self.client.messages.create(
                    model=self.config.anthropic_model,
                    max_tokens=self.config.max_tokens_summary,
                    system=[
                        {
                            "type": "text",
                            "text": system_prompt,
                            "cache_control": {"type": "ephemeral"},
                        }
                    ],
                    messages=[{"role": "user", "content": user_prompt}],
                )
                # Extrai apenas os blocos de texto. Modelos com extended
                # thinking retornam um ThinkingBlock antes do TextBlock — pegar
                # content[0] cegamente quebraria (ThinkingBlock não tem .text).
                text_parts = [
                    block.text
                    for block in message.content
                    if getattr(block, "type", None) == "text"
                ]
                if not text_parts:
                    raise RuntimeError("Claude não retornou bloco de texto.")
                return "".join(text_parts)

            except anthropic.AuthenticationError as e:
                raise RuntimeError(
                    "Chave da API Anthropic inválida. "
                    "Verifique o arquivo .env com ANTHROPIC_API_KEY."
                ) from e
            except self._RETRYABLE as e:
                last_err = e
                if attempt < retries - 1:
                    wait = 2 ** (attempt + 1)
                    logger.warning(
                        "Erro transitório na API Anthropic (%s). Retry em %ds (%d/%d)...",
                        type(e).__name__, wait, attempt + 1, retries,
                    )
                    time.sleep(wait)
                else:
                    raise

        raise RuntimeError(
            f"Falha ao chamar API Anthropic após {retries} tentativas: {last_err}"
        )


# ---------------------------------------------------------------------------
# Provedor: Ollama (LLM local)
# ---------------------------------------------------------------------------


class OllamaSummarizer(_BaseSummarizer):
    """Resume reuniões usando um servidor Ollama local.

    Requer o Ollama instalado e rodando. Veja ``docs/llm-local.md``.

    Endpoint usado: ``POST {base_url}/api/chat`` com ``format: "json"`` para
    forçar saída em JSON estruturado, e ``stream: false`` para resposta única.
    """

    provider_name = "ollama"

    def __init__(self, config: Settings):
        super().__init__(config)
        self.base_url = config.ollama_base_url.rstrip("/")
        self.model = config.ollama_model
        self.timeout = config.ollama_request_timeout
        self.temperature = config.ollama_temperature
        self.num_ctx = config.ollama_num_ctx

    def _call_llm(self, system_prompt: str, user_prompt: str, retries: int = 2) -> str:
        url = f"{self.base_url}/api/chat"
        payload = {
            "model": self.model,
            "stream": False,
            # Força saída em JSON. qwen2.5/llama3.1 respeitam isso.
            "format": "json",
            "options": {
                "temperature": self.temperature,
                "num_ctx": self.num_ctx,
                "num_predict": self.config.max_tokens_summary,
            },
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
        }

        last_err: Exception | None = None
        for attempt in range(retries):
            try:
                with httpx.Client(timeout=self.timeout) as client:
                    logger.debug(
                        "Chamando Ollama %s (modelo=%s, num_ctx=%d)",
                        url,
                        self.model,
                        self.num_ctx,
                    )
                    response = client.post(url, json=payload)
                    if response.status_code == 404:
                        raise RuntimeError(
                            f"Ollama respondeu 404. Verifique se o modelo "
                            f"'{self.model}' está instalado: "
                            f"`ollama pull {self.model}`."
                        )
                    response.raise_for_status()
                    data = response.json()

                # /api/chat retorna {"message": {"content": "..."}, ...}
                message = data.get("message", {})
                content = message.get("content")
                if not content:
                    raise RuntimeError(
                        f"Resposta inesperada do Ollama: {str(data)[:200]}"
                    )
                return content

            except httpx.ConnectError as e:
                # Ollama pode estar subindo — vale tentar de novo, não falhar na hora.
                last_err = e
                if attempt < retries - 1:
                    wait = 2 ** (attempt + 1)
                    logger.warning(
                        "Ollama indisponível (conexão). Retry em %ds (%d/%d)...",
                        wait, attempt + 1, retries,
                    )
                    time.sleep(wait)
                else:
                    raise RuntimeError(
                        f"Não foi possível conectar ao Ollama em {self.base_url}. "
                        f"Verifique se o serviço está rodando "
                        f"(`ollama serve` ou app do Ollama aberto)."
                    ) from e
            except httpx.HTTPError as e:
                last_err = e
                if attempt < retries - 1:
                    wait = 2 ** (attempt + 1)
                    logger.warning(
                        "Erro HTTP no Ollama (%s). Tentando novamente em %ds...",
                        e,
                        wait,
                    )
                    time.sleep(wait)
                else:
                    raise RuntimeError(
                        f"Falha ao chamar Ollama após {retries} tentativas: {e}"
                    ) from e

        raise RuntimeError(f"Falha ao chamar Ollama: {last_err}")


# ---------------------------------------------------------------------------
# Provedor: OpenAI e compatíveis (OpenRouter, Groq, DeepSeek, xAI, Azure...)
# ---------------------------------------------------------------------------


class OpenAISummarizer(_BaseSummarizer):
    """Resume via API compatível com a OpenAI (``/chat/completions``).

    O mesmo provedor cobre a OpenAI e qualquer serviço compatível: basta
    apontar ``openai_base_url`` e definir a chave correspondente. Assim,
    modelos novos do mercado funcionam sem mudança de código.
    """

    provider_name = "openai"

    def __init__(self, config: Settings):
        super().__init__(config)
        if not config.openai_api_key:
            raise RuntimeError(
                "OPENAI_API_KEY não definido. Configure no .env "
                "(ou troque o provedor de LLM)."
            )
        self.base_url = config.openai_base_url.rstrip("/")
        self.model = config.openai_model
        self.api_key = config.openai_api_key
        self.timeout = config.openai_request_timeout

    def _call_llm(self, system_prompt: str, user_prompt: str, retries: int = 3) -> str:
        url = f"{self.base_url}/chat/completions"
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        use_json_mode = True
        last_err: Exception | None = None

        for attempt in range(retries):
            payload: dict = {
                "model": self.model,
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
            }
            if use_json_mode:
                payload["response_format"] = {"type": "json_object"}

            try:
                with httpx.Client(timeout=self.timeout) as client:
                    resp = client.post(url, headers=headers, json=payload)
                    if resp.status_code == 401:
                        raise RuntimeError(
                            "Chave da API inválida (HTTP 401). "
                            "Verifique OPENAI_API_KEY no .env."
                        )
                    # Alguns endpoints compatíveis não suportam response_format.
                    if resp.status_code == 400 and use_json_mode:
                        logger.warning(
                            "Endpoint recusou response_format; tentando sem JSON mode."
                        )
                        use_json_mode = False
                        continue
                    resp.raise_for_status()
                    data = resp.json()

                choices = data.get("choices", [])
                if not choices:
                    raise RuntimeError(
                        f"Resposta inesperada da API: {str(data)[:200]}"
                    )
                return choices[0].get("message", {}).get("content", "")

            except httpx.ConnectError as e:
                last_err = e
                if attempt < retries - 1:
                    wait = 2 ** (attempt + 1)
                    logger.warning(
                        "Conexão com %s falhou. Retry em %ds (%d/%d)...",
                        self.base_url, wait, attempt + 1, retries,
                    )
                    time.sleep(wait)
                else:
                    raise RuntimeError(
                        f"Não foi possível conectar a {self.base_url}. "
                        f"Verifique openai_base_url."
                    ) from e
            except httpx.HTTPError as e:
                last_err = e
                if attempt < retries - 1:
                    wait = 2 ** (attempt + 1)
                    logger.warning(
                        "Erro HTTP na API OpenAI (%s). Tentando novamente em %ds...",
                        e,
                        wait,
                    )
                    time.sleep(wait)
                else:
                    raise RuntimeError(
                        f"Falha ao chamar a API OpenAI após {retries} tentativas: {e}"
                    ) from e

        raise RuntimeError(f"Falha ao chamar a API OpenAI: {last_err}")


# ---------------------------------------------------------------------------
# Provedor: Google Gemini (API nativa)
# ---------------------------------------------------------------------------


class GeminiSummarizer(_BaseSummarizer):
    """Resume via API nativa do Google Gemini (``generateContent``)."""

    provider_name = "gemini"

    def __init__(self, config: Settings):
        super().__init__(config)
        if not config.gemini_api_key:
            raise RuntimeError(
                "GEMINI_API_KEY não definido. Configure no .env "
                "(ou troque o provedor de LLM)."
            )
        self.base_url = config.gemini_base_url.rstrip("/")
        self.model = config.gemini_model
        self.api_key = config.gemini_api_key
        self.timeout = config.gemini_request_timeout

    def _call_llm(self, system_prompt: str, user_prompt: str, retries: int = 3) -> str:
        url = f"{self.base_url}/v1beta/models/{self.model}:generateContent"
        payload = {
            "system_instruction": {"parts": [{"text": system_prompt}]},
            "contents": [{"role": "user", "parts": [{"text": user_prompt}]}],
            "generationConfig": {"responseMimeType": "application/json"},
        }
        last_err: Exception | None = None

        for attempt in range(retries):
            try:
                with httpx.Client(timeout=self.timeout) as client:
                    resp = client.post(
                        url, params={"key": self.api_key}, json=payload
                    )
                    if resp.status_code in (401, 403):
                        raise RuntimeError(
                            "Chave da API Gemini inválida. "
                            "Verifique GEMINI_API_KEY no .env."
                        )
                    if resp.status_code == 404:
                        raise RuntimeError(
                            f"Modelo Gemini '{self.model}' não encontrado (HTTP 404). "
                            f"Confira gemini_model."
                        )
                    resp.raise_for_status()
                    data = resp.json()

                candidates = data.get("candidates", [])
                if not candidates:
                    raise RuntimeError(
                        f"Resposta inesperada do Gemini: {str(data)[:200]}"
                    )
                parts = candidates[0].get("content", {}).get("parts", [])
                text = "".join(p.get("text", "") for p in parts)
                if not text:
                    raise RuntimeError(
                        f"Gemini não retornou texto: {str(data)[:200]}"
                    )
                return text

            except httpx.ConnectError as e:
                last_err = e
                if attempt < retries - 1:
                    wait = 2 ** (attempt + 1)
                    logger.warning(
                        "Conexão com o Gemini falhou. Retry em %ds (%d/%d)...",
                        wait, attempt + 1, retries,
                    )
                    time.sleep(wait)
                else:
                    raise RuntimeError(
                        f"Não foi possível conectar ao Gemini em {self.base_url}."
                    ) from e
            except httpx.HTTPError as e:
                last_err = e
                if attempt < retries - 1:
                    wait = 2 ** (attempt + 1)
                    logger.warning(
                        "Erro HTTP no Gemini (%s). Tentando novamente em %ds...",
                        e,
                        wait,
                    )
                    time.sleep(wait)
                else:
                    raise RuntimeError(
                        f"Falha ao chamar o Gemini após {retries} tentativas: {e}"
                    ) from e

        raise RuntimeError(f"Falha ao chamar o Gemini: {last_err}")


# ---------------------------------------------------------------------------
# Factory pública
# ---------------------------------------------------------------------------


def MeetingSummarizer(config: Settings) -> SummarizerProtocol:  # noqa: N802 (factory mantém nome legado)
    """Cria o summarizer apropriado conforme ``config.llm_provider``.

    Mantém o nome ``MeetingSummarizer`` por compatibilidade com o código
    existente (``pipeline.py``, ``test_pipeline.py``). Apesar de parecer uma
    classe, é uma função factory que retorna a instância concreta.
    """
    provider = (config.llm_provider or "anthropic").lower().strip()

    if provider == "none":
        raise RuntimeError(
            "llm_provider='none' não usa LLM (modo só transcrição). "
            "O resumo não deveria ter sido chamado."
        )

    if provider in ("local", "ollama"):
        logger.info(
            "LLM provider: ollama (modelo=%s, base_url=%s)",
            config.ollama_model,
            config.ollama_base_url,
        )
        return OllamaSummarizer(config)

    if provider == "anthropic":
        logger.info("LLM provider: anthropic (modelo=%s)", config.anthropic_model)
        return AnthropicSummarizer(config)

    if provider == "openai":
        logger.info(
            "LLM provider: openai (modelo=%s, base_url=%s)",
            config.openai_model,
            config.openai_base_url,
        )
        return OpenAISummarizer(config)

    if provider == "gemini":
        logger.info("LLM provider: gemini (modelo=%s)", config.gemini_model)
        return GeminiSummarizer(config)

    raise ValueError(
        f"llm_provider desconhecido: '{provider}'. Valores válidos: "
        f"'anthropic', 'openai', 'gemini', 'local' (alias 'ollama')."
    )


__all__ = [
    "MeetingSummarizer",
    "AnthropicSummarizer",
    "OpenAISummarizer",
    "GeminiSummarizer",
    "OllamaSummarizer",
    "SummarizerProtocol",
    "SummaryParseError",
    "SYSTEM_PROMPT",
]
