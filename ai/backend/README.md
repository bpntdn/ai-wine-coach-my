# Maenads AI Backend (FastAPI + RAG Skeleton)

## 1) 安裝
```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

## 2) 設定環境變數
- 在 `.env` 放入 `OPENAI_API_KEY`
- 可選：`VECTOR_BACKEND=pinecone|weaviate|supabase`
- 若用 Supabase：
  - 設 `VECTOR_BACKEND=supabase`
  - 設 `SUPABASE_URL`、`SUPABASE_KEY`
  - 先到 Supabase SQL Editor 執行 `sql/supabase_setup.sql`

## 3) 啟動
```bash
uvicorn app.main:app --reload --port 8000
```

## 4) API
- `GET /health`
- `POST /chat`
```json
{
  "message": "老闆在場客戶壓價，我下一句怎麼說？",
  "top_k": 5
}
```

## 5) 前端串接
React Native / Web 皆可對 `POST /chat` 取得即時回覆。

## 6) 匯入 RAG 種子知識（Supabase）
```bash
cd backend
source .venv/bin/activate
python scripts/ingest_supabase.py
```

成功後 `/chat` 會先檢索 `knowledge_chunks` 再生成回覆。
