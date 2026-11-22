# PLAN: 个人活动信息看板 — 0.1 垂直切片与迭代路线

> **指导原则**：不做“先写完所有后端再写前端”的水平堆砌；先用最少的文件打通一条**“PC 粘贴图文 → 百炼多模态编译 → 确定性三层漏斗渲染”**的端到端细管，在本地 `wrangler dev` 零云端配置下直接跑通闭环，再逐层叠加离线缓存、防覆盖锁与日历订阅。

---

## 1. 0.1 垂直切片的范围界定

### 本阶段只做（通链路）
1. **底层双表存储**：初始化 `events` 与 `raw_items`（预留 `user_overrides` 与图片摘要字段，避免后续破坏性改表）。
2. **最薄鉴权门禁**：单一口令校验，保护全部 API 与图片读取代理（满足 `SPEC` 安全底线）。
3. **PC 端无摩擦录入**：一键盲建空活动容器 → `Ctrl+V` 贴入文本与图片 → 存入存储层。
4. **百炼多模态编译管道**：通过 OpenAI 兼容接口调用阿里云百炼视觉模型（如 `qwen-vl-max` / `qwen-vl-plus`），输出严格符合 Schema 的结构化 JSON，并完成图片语义分诊（识别二维码/展馆图/普通海报）。
5. **确定性三层视图渲染**：前端按 `L1 救命层 + L2 按需模块（无数据隐藏） + L3 原始栈` 渲染，点击 L1 凭证图可全屏查看。

### 本阶段暂缓（留给 0.2 / 0.3 切片）
* 暂缓：人工字段修改锁（`user_overrides` 编辑 UI 与冲突确认条）→ 移交 **0.2**。
* 暂缓：增量追加时的历史图片摘要缓存复用与红标变更比对调优 → 移交 **0.2**。
* 暂缓：PWA Service Worker 断网离线缓存与同步绿灯 → 移交 **0.3**。
* 暂缓：WebCal `/cal/:token.ics` 订阅与单条 `.ics` 导出 → 移交 **0.3**。
* 暂缓：Cloudflare 云端正式部署、绑卡开 R2 与自定义域名绑定 → 移交 **0.3**（0.1 全程在本地模拟器跑通）。

---

## 2. 极简文件目录与分层架构（共 8 个文件）

采用类似嵌入式固件的清晰分层思想：**配置层 → 契约层 → 驱动层（存储）→ 算法层（AI 编译）→ 路由层 → 极薄前端**，零重型框架依赖，全部代码透明可控。

```text
event-board/
├── wrangler.toml        # [配置] Cloudflare Workers、D1、R2 与静态资源绑定配置
├── schema.sql           # [数据库] D1 建表语句（events + raw_items，一次性预留演化字段）
├── src/
│   ├── types.ts         # [契约层] 全局 TypeScript 接口与 JSON 协议定义（唯一真相源）
│   ├── storage.ts       # [驱动层] D1 读写与 R2 图片存取封装（隔离底层存储细节）
│   ├── compiler.ts      # [编译层] 调用百炼 OpenAI 兼容接口，组装 Prompt 与校验输出 JSON
│   └── index.ts         # [路由层] 鉴权中间件、REST API 路由、受保护的图片流式代理
└── public/
    ├── index.html       # [视图骨架] 响应式单页（宽屏录入台 / 窄屏作战卡）与全屏亮码弹窗
    └── app.js           # [交互逻辑] Ctrl+V 粘贴捕获、前端图片适度压缩、API 请求与确定性渲染
```

### 0.1 阶段最小 API 接口清单（共 6 个端点）
* `POST /api/events`：一键盲建空活动容器，返回 `event_id`。
* `GET /api/events`：拉取活动列表（按时间排序，自动区分“即将发生”与“历史归档”）。
* `GET /api/events/:id`：拉取单场活动的完整视图数据（编译视图 + 原始栈）。
* `POST /api/events/:id/items`：往原始栈追加一条文本、链接或图片。
* `POST /api/events/:id/compile`：触发百炼多模态模型编译该活动并更新视图。
* `GET /api/images/:key`：鉴权后从 R2 代理吐出原始图片（禁止公网匿名访问）。

---

## 3. 模块间标准 JSON 通信契约

所有模块之间严禁传递非结构化散装数据，严格遵守以下 3 份核心 JSON 契约。

### 契约 A：前端 → 后端（写入原始栈 `raw_items`）
文本/链接使用 JSON 提交；图片使用 `multipart/form-data` 提交，后端统一返回如下标准条目对象：

```json
{
  "id": "item_01J9X...",
  "event_id": "evt_01J9W...",
  "type": "image",
  "content": "events/evt_01J9W.../qr_01.webp",
  "ai_role": null,
  "ai_summary": null,
  "created_at": "2026-11-21T10:15:00Z"
}
```
*注：`type` 仅允许 `"text"`、`"image"`、`"url"`。`ai_role` 与 `ai_summary` 在入栈时为空，首次编译后由后端回填，为 0.2 阶段的增量缓存奠基。*

### 契约 B：后端 → 百炼模型 → 后端（AI 编译输出 `CompiledEventData`）
`compiler.ts` 强制约束模型仅返回此 JSON 结构（任何字段缺失必须填 `null` 或空数组 `[]`，严禁自由发挥新字段）：

```json
{
  "l1_core": {
    "title": "2026 深圳机器人开发者大会",
    "start_time": "2026-12-05T09:00:00+08:00",
    "end_time": "2026-12-05T18:00:00+08:00",
    "time_display": "12月5日 09:00 - 18:00",
    "location_name": "深圳会展中心（福田）3号馆",
    "location_address": "深圳市福田区福华三路深圳会展中心3号馆",
    "ticket_image_id": "item_01J9X_qr",
    "redlines": [
      "必须携带实体身份证原件刷闸机",
      "08:45 停止主论坛检票"
    ],
    "change_alerts": []
  },
  "l2_modules": {
    "schedule": [
      {
        "time": "09:30 - 11:00",
        "title": "具身智能与运动控制主论坛",
        "location": "3号馆主舞台"
      }
    ],
    "zones": [
      {
        "zone_name": "B区 电机与电控展位",
        "highlights": "B12 宇树、B15 达妙科技",
        "map_image_id": "item_01J9X_map"
      }
    ],
    "personal_focus": [
      "去 B15 问一下新型关节电机的通信协议与样机价格"
    ],
    "contacts_links": [
      {
        "label": "官方报名回执链接",
        "value": "https://example.com/ticket",
        "type": "url"
      }
    ]
  },
  "image_triage": [
    {
      "item_id": "item_01J9X_qr",
      "role": "ticket_qr",
      "summary": "大会入场签到二维码，核销码 8842"
    },
    {
      "item_id": "item_01J9X_map",
      "role": "venue_map",
      "summary": "3号馆A/B/C展区平面分布图"
    }
  ]
}
```
*约束说明*：
* 前端根据 `l2_modules` 各子数组是否为空决定是否渲染对应模块——**为空则彻底隐身**，确保单点宣讲会与大型展会共用同一套契约。
* `time_display` 专门兜底“12月中旬”这类时间模糊的预热海报（此时 `start_time` 允许为 `null`）。

### 契约 C：后端 → 前端（活动详情完整响应 `EventDetailResponse`）
后端将 `compiled_data` 与 `user_overrides` 合并后下发给前端（0.1 阶段 `user_overrides` 默认为空对象 `{}`）：

```json
{
  "meta": {
    "id": "evt_01J9W...",
    "status": "upcoming",
    "version": 1,
    "compiled_at": "2026-11-21T10:15:12Z"
  },
  "view": {
    "l1_core": { "...同契约 B..." },
    "l2_modules": { "...同契约 B..." }
  },
  "locked_fields": [],
  "raw_stack": [
    {
      "id": "item_01J9X_qr",
      "type": "image",
      "url": "/api/images/events/evt_01J9W.../qr_01.webp",
      "ai_role": "ticket_qr",
      "created_at": "2026-11-21T10:15:00Z"
    }
  ]
}
```

---

## 4. 第一步要跑通什么（0.1 端到端冒烟验收路径）

在完全不碰域名注册、不绑卡开云端 R2 的前提下，仅利用本地 `wrangler dev`（自动模拟 D1 与 R2）+ 你的本地百炼 API Key，按以下 5 步走通即宣告 **0.1 垂直切片胜利**：

1. **环境点火**：配置本地 `.dev.vars`（填入你的 `DASHSCOPE_API_KEY`、`DASHSCOPE_BASE_URL`、`MODEL_NAME` 与自定义访问口令 `AUTH_TOKEN`），执行本地数据库建表并启动 `wrangler dev`。
2. **门禁验证**：用无口令的浏览器隐私窗口请求 `/api/events` 或图片路径，必须返回 `401 Unauthorized`。
3. **测试样本 1（单点宣讲会）**：输入口令进入 PC 录入页 → 点「+ 新活动」→ 粘贴一段微信讲座通知 + 1 张签到二维码截图 → 点击「保存并整理」。
   * **通过标准**：页面自动填出标题、时间、地址；L1 首屏直接置顶该二维码（点击可全屏放大）；L2 展馆与议程模块完全隐藏不占位；L3 底部保留原图与原文。
4. **测试样本 2（大型多馆展会）**：新建第二个活动 → 粘贴一段含个人关注目标的笔记 + 1 张议程长图 + 1 张展馆平面图 + 1 张门票码 → 点击「保存并整理」。
   * **通过标准**：同一套页面自动点亮 L2 时间轴与空间路由模块；门票码精准提拔至 L1，展馆图精准挂载至 L2 空间模块，无需任何人工分类。
5. **时间轴归档校验**：将其中一条测试数据时间改为昨天，刷新首页，确认它自动从“即将发生”列表中消失并进入“历史归档”区。

---

## 5. 后续切片路线图（跑通 0.1 后再展开）

| 版本 | 核心目标 | 对应解决 `SPEC` / 经理审计问题 |
| :--- | :--- | :--- |
| **0.2 演化闭环** | 增量追加时复用 `raw_items.ai_summary` 防重扫爆上下文；支持删除错传条目；上线 `user_overrides` 人工修改锁与冲突红标提示条。 | 解决 AC-3 增量防覆盖 & 多图编译速度与账单问题。 |
| **0.3 离线与日历** | 注入 PWA Manifest 与 Service Worker 离线缓存（含顶部绿灯同步状态提示）；上线 `/cal/:token.ics` 动态订阅 + 单条 `.ics` 紧急导入按钮。 | 解决 AC-1 断网秒开 & AC-4 零双录提醒与刷新延迟兜底。 |
| **1.0 上线服役** | 绑定个人域名、部署至 Cloudflare 线上环境、手机添加到主屏幕，投入真实活动实战检验。 | 脱离本机局域网，全天候服役。 |