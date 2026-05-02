-- 啟用向量延伸
create extension if not exists vector;

-- 知識片段表
create table if not exists public.knowledge_chunks (
  id text primary key,
  content text not null,
  metadata jsonb default '{}'::jsonb,
  embedding vector(1536) not null
);

-- 向量索引（ivfflat）
create index if not exists knowledge_chunks_embedding_idx
on public.knowledge_chunks
using ivfflat (embedding vector_cosine_ops)
with (lists = 100);

-- 檢索函式：回傳內容與分數
create or replace function public.match_knowledge_chunks(
  query_embedding vector(1536),
  match_count int default 5
)
returns table (
  id text,
  content text,
  metadata jsonb,
  score float
)
language sql
as $$
  select
    kc.id,
    kc.content,
    kc.metadata,
    1 - (kc.embedding <=> query_embedding) as score
  from public.knowledge_chunks kc
  order by kc.embedding <=> query_embedding
  limit match_count;
$$;
