import json
import os
from pathlib import Path
from dotenv import load_dotenv
import httpx
from openai import OpenAI

load_dotenv()

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL", "text-embedding-3-small")
SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_KEY = os.getenv("SUPABASE_KEY", "")
SUPABASE_TABLE = os.getenv("SUPABASE_TABLE", "knowledge_chunks")


def ensure_env():
    missing = []
    for k, v in [
        ("OPENAI_API_KEY", OPENAI_API_KEY),
        ("SUPABASE_URL", SUPABASE_URL),
        ("SUPABASE_KEY", SUPABASE_KEY),
    ]:
        if not v:
            missing.append(k)
    if missing:
        raise RuntimeError(f"缺少環境變數：{', '.join(missing)}")


def embed(client: OpenAI, text: str):
    res = client.embeddings.create(model=EMBEDDING_MODEL, input=text)
    return res.data[0].embedding


def main():
    ensure_env()
    client = OpenAI(api_key=OPENAI_API_KEY)

    seed_path = Path(__file__).resolve().parents[1] / "data" / "knowledge_seed.json"
    rows = json.loads(seed_path.read_text(encoding="utf-8"))

    upserts = []
    for r in rows:
        upserts.append(
            {
                "id": r["id"],
                "content": r["content"],
                "metadata": r.get("metadata", {}),
                "embedding": embed(client, r["content"]),
            }
        )

    url = f"{SUPABASE_URL}/rest/v1/{SUPABASE_TABLE}"
    headers = {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates",
    }

    resp = httpx.post(url, headers=headers, json=upserts, timeout=60.0)
    if resp.status_code >= 300:
        raise RuntimeError(f"上傳失敗：{resp.status_code} {resp.text}")

    print(f"完成匯入，共 {len(upserts)} 筆")


if __name__ == "__main__":
    main()
