-- 活动主表：存编译后的结构化视图与人工覆写层
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'draft',          -- draft | compiled | archived
  compiled_json TEXT,                            -- AI 编译出的标准三层漏斗 JSON
  overrides_json TEXT NOT NULL DEFAULT '{}',     -- 人工手改的锁定字段 JSON（优先级最高）
  version INTEGER NOT NULL DEFAULT 1,            -- 每次变动自增，供后续移动端判断缓存是否过期
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 原始素材栈：严格按入栈时间顺序记录每一条文本、链接或图片
CREATE TABLE IF NOT EXISTS raw_items (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  type TEXT NOT NULL,                            -- text | image | url
  content TEXT,                                  -- 文本内容或参考链接
  image_key TEXT,                                -- 存入 R2 储物柜的文件路径
  image_summary TEXT,                            -- 单图入栈/首次编译时缓存的 OCR 与类型分诊摘要
  created_at TEXT NOT NULL,
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
);

-- 加速按活动查原始素材
CREATE INDEX IF NOT EXISTS idx_raw_items_event_time
  ON raw_items(event_id, created_at);
