from pydantic import BaseModel, Field
from typing import List, Optional


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=4000)
    user_id: Optional[str] = None
    top_k: int = 5


class SourceChunk(BaseModel):
    id: str
    text: str
    score: float
    metadata: dict = {}


class ChatResponse(BaseModel):
    reply: str
    suggested_script: str = ""
    wine_hint: str = ""
    followup: str = "有沒有解決你的問題？你還想知道什麼？"
    sources: List[SourceChunk] = []
