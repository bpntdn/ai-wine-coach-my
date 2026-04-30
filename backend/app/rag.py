from typing import List, Optional
import httpx
from .schemas import SourceChunk
from .config import settings


class VectorStore:
    # 中文註解：統一向量庫介面，方便替換 Pinecone / Weaviate / Supabase
    async def search(self, query: str, top_k: int = 5, query_embedding: Optional[List[float]] = None) -> List[SourceChunk]:
        return []


class NoopVectorStore(VectorStore):
    async def search(self, query: str, top_k: int = 5, query_embedding: Optional[List[float]] = None) -> List[SourceChunk]:
        return []


class SupabaseVectorStore(VectorStore):
    async def search(self, query: str, top_k: int = 5, query_embedding: Optional[List[float]] = None) -> List[SourceChunk]:
        if not settings.supabase_url or not settings.supabase_key or not query_embedding:
            return []

        rpc_url = f"{settings.supabase_url}/rest/v1/rpc/match_knowledge_chunks"
        headers = {
            "apikey": settings.supabase_key,
            "Authorization": f"Bearer {settings.supabase_key}",
            "Content-Type": "application/json",
        }
        payload = {
            "query_embedding": query_embedding,
            "match_count": top_k,
        }
        try:
            async with httpx.AsyncClient(timeout=20.0) as client:
                resp = await client.post(rpc_url, headers=headers, json=payload)
                if resp.status_code >= 300:
                    return []
                rows = resp.json() or []
        except Exception:
            return []

        out: List[SourceChunk] = []
        for r in rows:
            out.append(
                SourceChunk(
                    id=str(r.get("id", "")),
                    text=str(r.get("content", "")),
                    score=float(r.get("score", 0.0)),
                    metadata=r.get("metadata", {}) or {},
                )
            )
        return out


class PineconeVectorStore(VectorStore):
    async def search(self, query: str, top_k: int = 5, query_embedding: Optional[List[float]] = None) -> List[SourceChunk]:
        return []


class WeaviateVectorStore(VectorStore):
    async def search(self, query: str, top_k: int = 5, query_embedding: Optional[List[float]] = None) -> List[SourceChunk]:
        return []


def get_vector_store() -> VectorStore:
    backend = (settings.vector_backend or "none").lower()
    if backend == "supabase":
        return SupabaseVectorStore()
    if backend == "pinecone":
        return PineconeVectorStore()
    if backend == "weaviate":
        return WeaviateVectorStore()
    return NoopVectorStore()
