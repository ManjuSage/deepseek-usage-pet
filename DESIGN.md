# DeepSeek API Usage Pet — 设计文档

> 状态：已实现
> 更新日期：2026-09-01

## 1. 项目定位

独立改造版的 DeepSeek 桌面鲸鱼桌宠，基于 [momo-OwO-qwq/DeepSeek-Whale-Pet](https://github.com/momo-OwO-qwq/DeepSeek-Whale-Pet)（MIT）二次开发，已与原项目分离，是另一个项目。

在原有透明置顶鲸鱼（余额气泡 + 拖拽 + Q 弹）基础上，新增/改造：

- 托盘（显示/隐藏勾选状态、鼠标穿透、用量统计入口、自启、退出）
- 平台令牌自动登录（Electron 登录窗 + 手动粘贴兜底）
- 用量统计面板（历史日级回填、日级/分时图表、充值余额、上次同步时间）

## 2. 技术底座

| 项 | 值 | 说明 |
|---|---|---|
| Electron | `^39.0.0` | 无 `node:sqlite` |
| SQLite 驱动 | `sql.js`（WASM） | better-sqlite3 因 NAPI/编译问题不可用 |
| 图表 | ECharts（`renderer/echarts.min.js`） | 复用 33March7/deepseek-api-usage-statistics（Unlicense） |
| 语言 | 原生 JS（无框架/打包器） | `npm start` 直接跑 |

## 3. 数据源（2 个）

### 3.1 官方余额 API —— 余额显示 + 记账

- `GET https://api.deepseek.com/user/balance`
- `Authorization: Bearer <DEEPSEEK_API_KEY>`
- 返回 `balance_infos[]`：`total_balance` / `granted_balance` / `topped_up_balance`（多币种挑 CNY 非零项）

### 3.2 平台私有用量接口 —— 用量统计 + 余额

- 域名 `https://platform.deepseek.com`
- `Authorization: Bearer <DEEPSEEK_PLATFORM_TOKEN>`（平台会话令牌，**非** API Key）

| 端点 | 用途 |
|---|---|
| `/api/v0/usage/by_api_key/amount?start=&end=&tz=` | 用量 tokens（`bucket=3600` 为分时） |
| `/api/v0/usage/by_api_key/cost?start=&end=&tz=` | 费用金额 |
| `/api/v0/users/get_user_summary` | 充值余额 / 赠金 / 累计花费 |

限制（实测）：单次最多 30 天；分时仅保留今天 + 昨天；GMT+8 分日桶；空区间返回空 series。

计费类型映射：`PROMPT_CACHE_HIT_TOKEN→input_cache_hit_tokens`、`PROMPT_CACHE_MISS_TOKEN→input_cache_miss_tokens`、`RESPONSE_TOKEN→output_tokens`、`REQUEST→request_count`。

## 4. 存储设计（sql.js SQLite）

```sql
amount_daily(utc_date, model, api_key_name, type, amount, price)          -- 日级用量
cost_daily(utc_date, model, api_key_name, wallet_type, cost, currency)    -- 日级费用
hourly_usage(utc_date, hour, model, api_key_name, type, amount)           -- 分时用量
hourly_cost(utc_date, hour, model, api_key_name, cost, currency)          -- 分时费用
meta(key, value)                                                          -- 账号指纹/余额/上次同步
```

- 主键 `(date[, hour], model, api_key_name, type|currency)`，`INSERT OR REPLACE` 做 upsert 去重。
- `config.json` 保持 JSON（API Key / platformToken / 设置），其余进 SQLite。
- 账号指纹（api_key 集合哈希）存 `meta`，检测换账号防混数据。

## 5. 功能模块

1. **桌宠**：余额气泡、拖拽、Q 弹、点击穿透（setShape）、低余额提醒、随机台词、峰谷提示、闲置半透明、方向感知镜像（设置可开关、关闭锁定方向）。
2. **托盘**：显示/隐藏勾选、鼠标穿透勾选、立即刷新、打开设置、用量统计、开机自启、退出。
3. **设置**：API Key、平台令牌（自动登录）、外观/文案/音效/图片/台词、镜像翻转开关、打开日志。
4. **用量统计**：历史回填、近 7/30/90/365 天或自定义日期、每日用量走势（按模型/按计费类型/按 API Key，支持 Tokens/费用切换）+ 各模型占比饼图 + 累计趋势 + 用量热力图 + 分时下钻（弹窗）、充值余额卡片、上次同步时间（GMT+8）。
5. **日志**：文件日志 `pet.log`（1MB 轮转 + 密钥掩码），主进程关键点埋点，Windows 终端按本机代码页回显避免乱码。

## 6. 关键决策

1. **sql.js 而非 better-sqlite3**：better-sqlite3 原生模块有 NAPI 兼容问题，且本机缺 ClangCL 编译失败。
2. **`setShape` 传 `{x,y,width,height}` 整数**：传 `{w,h}` 或浮点会使 shape 无效、全窗口拦截鼠标。
3. **平台令牌**：登录窗自动提取（localStorage `userToken` 等）+ 手动粘贴兜底。
4. **历史回填**：30 天一段往回回溯，遇连续两段空即停。
5. **移除「每轮花费」**：DeepSeek 明示「数据可能有 5 分钟延迟」，余额差值无法精确到单轮。
6. **`disableHardwareAcceleration`**：图形简单，软件渲染省约 260MB。
7. **范围选择**：近 7 天默认 + 30/90/365 + 自定义日期（预设按钮 + 始终可见的日期输入框）。
8. **记账对账取大**：配置平台令牌时，记账模式每次刷新取「余额差值 vs 平台今日用量」较大值。
9. **启动自动同步**：启动 + 每小时检查，超 12h 做一次轻量同步（不含历史回填），`autoSync` 可关。
10. **SQLite 批量落盘**：`beginBatch()/flush()` 让一次同步只落盘一次。
11. **模型定价精确匹配**：未知模型走默认价；平台把旧版 chat/reasoner 合并为 `deepseek-chat & deepseek-reasoner`。
12. **安全加固与 CSP 收紧**：密钥掩码、openPath 白名单、登录窗护栏、raw 留存上限、三页 `object-src/base-uri/connect-src 'none'`。
13. **镜像翻转**：`mirror` 默认开启，方向感知自动镜像（整窗 `scaleX(-1)`，鲸鱼+气泡一起翻、文字/动图反向翻回，旋转中心为两者合起来的中部）；关闭=锁定当前方向；重启回默认。
14. **缩放/多屏适配**：小屏动态限制最大缩放；多显示器镜像锚点随屏更新；跨屏钳制统一 `getDisplayMatching`；缩放用一次原子 `setBounds`（避免 `setSize`+`setPosition` 竞态导致位移受限/漂移）。
15. **运行日志**：`lib/log.js` 写 `pet.log`，默认 info，`WHALE_PET_LOG_LEVEL`/`WHALE_PET_TRACE` 开 debug；`redact()` 掩码密钥；`config.readFile` 不打日志防递归。Windows 终端用 `chcp`+`iconv-lite` 按本机代码页编码，文件保持 UTF-8。

## 7. 风险与缓解

- 私有接口无文档、可能变动、token 过期：原始响应存档 + 结构变化报错 + 降级。
- 账号混数据：账号指纹检测。
- 分时限制：平台只保留今昨，但本地会累积保存；未在窗口内同步过的日期无分时（面板提示「无保存的分时数据」）。
- 鼠标穿透平台差异：Windows/macOS 用 `setIgnoreMouseEvents`，Linux/X11 用空 `setShape`；Wayland/XWayland 下不可靠，需用户改用 X11 会话。

## 8. 目录结构

```text
DeepseekAPIUsagePet/
├── AGENTS.md / DESIGN.md    # 项目说明 / 设计文档
├── main.js / preload.js     # Electron 主进程 / IPC 安全桥
├── lib/                     # balance / config / ledger / lines / log / store / usage-sync
├── renderer/                # pet（桌宠）/ menu（设置）/ usage（用量面板）/ echarts.min.js
├── assets/                  # 鲸鱼素材 / 音效
└── test/                    # 单元测试
```

## 9. 打包与分发

- 产物两种：`nsis`（向导式安装包）+ `portable`（免安装便携版）。
- 安装包配置见 `package.json` 的 `build.nsis`：向导式（`oneClick:false`）、安装范围可选（`perMachine:false`）、可选安装目录、中文语言包（`zh_CN` / `en_US`）、桌面 + 开始菜单快捷方式。
- 输出目录：`dist/installer/`（安装包）、`dist/portable/`（便携版 exe + zip + win-unpacked）。
- 未做代码签名：SmartScreen 会提示「未知发布者」，不阻塞运行（更多信息 → 仍要运行）。
- electron-builder 26 的部分二进制 npmmirror 可能缺失，需从 GitHub 手动下载到 `%LOCALAPPDATA%\electron-builder\Cache`。
