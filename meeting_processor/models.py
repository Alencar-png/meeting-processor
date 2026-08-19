"""Modelos de dados da transcrição."""

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
