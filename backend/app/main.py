from fastapi import FastAPI, HTTPException
from openai import OpenAI
from typing import List
from .config import settings
from .prompt import SYSTEM_PROMPT
from .schemas import ChatRequest, ChatResponse, SourceChunk
from .rag import get_vector_store

app = FastAPI(title="Maenads Coach API", version="1.0.0")

vector_store = get_vector_store()
client = OpenAI(api_key=settings.openai_api_key) if settings.openai_api_key else None

def embed_text(text: str) -> List[float]:
    if not client:
        return []
    emb = client.embeddings.create(
        model=settings.embedding_model,
        input=text,
    )
    return emb.data[0].embedding

@app.get("/health")
async def health():
    return {"ok": True, "model": settings.openai_model, "vector_backend": settings.vector_backend}


@app.post("/chat", response_model=ChatResponse)
async def chat(req: ChatRequest):
    if not client:
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY 尚未設定")

    query_embedding = embed_text(req.message)
    sources = await vector_store.search(req.message, top_k=req.top_k, query_embedding=query_embedding)
    context_text = "\n\n".join(
        [f"[來源:{s.id}][分數:{s.score:.3f}] {s.text}" for s in sources]
    )[:6000]

    user_message = req.message
    if context_text:
        user_message = (
            f"以下是可用知識片段，請優先依據這些內容回答，避免幻覺：\n{context_text}\n\n"
            f"使用者問題：{req.message}"
        )

    response = client.chat.completions.create(
        model=settings.openai_model,
        temperature=0.8,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_message},
        ],
    )

    reply = response.choices[0].message.content or "我先幫你整理一個可執行版本。"

    return ChatResponse(
        reply=reply,
        suggested_script="你可以先說：我先聽你的重點，再幫你配一個最穩的策略。",
        wine_hint="若是高壓場景，先用清爽白酒暖場，再用中等酒體紅酒收斂。",
        sources=[SourceChunk(**s.model_dump()) for s in sources],
    )
