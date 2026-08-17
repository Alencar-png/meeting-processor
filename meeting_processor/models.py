"""Modelos de dados para o pipeline de processamento de reuniões."""

from pydantic import BaseModel


class TranscriptSegment(BaseModel):
    start: float
    end: float
    text: str


class Transcript(BaseModel):
    segments: list[TranscriptSegment]
    full_text: str
    language: str
    duration: float


class TimeWindowSummary(BaseModel):
    start_minutes: int
    end_minutes: int
    summary: str


class ActionItem(BaseModel):
    description: str
    assignee: str | None = None
    priority: str | None = None
    due_date: str | None = None
    source_timestamp: str | None = None


class MeetingSummary(BaseModel):
    executive_summary: str
    # Resumo narrativo detalhado da reunião (vários parágrafos): contexto,
    # discussões, argumentos e conclusões. É o "resumo geral" — o foco.
    detailed_summary: str = ""
    # Decisões concretas tomadas na reunião.
    decisions: list[str] = []
    time_windows: list[TimeWindowSummary]
    action_items: list[ActionItem]
    participants: list[str]
    key_topics: list[str]


class ProcessingResult(BaseModel):
    source_file: str
    transcript: Transcript
    # summary/note_path ausentes no modo "só transcrição".
    summary: MeetingSummary | None = None
    note_path: str = ""
    raw_path: str
    processing_time: float
