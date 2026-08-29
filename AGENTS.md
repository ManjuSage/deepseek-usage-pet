# AGENTS.md — 项目说明

给后续的 AI Agent 或开发者快速了解本项目。改动前先读这里。

## 一句话

这是一个**独立改造版**的 DeepSeek 桌面鲸鱼桌宠：在透明置顶鲸鱼（余额气泡 + 拖拽 + Q 弹）基础上，扩展了**托盘**、**平台令牌登录**、**用量统计面板**（历史回填 + 日级/分时图表 + 余额 + 同步时间）。已与原项目 [momo-OwO-qwq/DeepSeek-Whale-Pet](https://github.com/momo-OwO-qwq/DeepSeek-Whale-Pet) 分离，是另一个项目。

## 技术栈

- Electron `^34.0.0`（内置 Node 20.18.1，Chromium 132）
- 原生 JS（无框架、无打包器），`npm start` 直接跑
- **sql.js**（WASM 版 SQLite，避免原生模块编译/ABI 问题）
- ECharts（用量面板图表，`renderer/echarts.min.js`）

## 架构

```text
main.js             Electron 主进程：窗口/托盘/IPC/登录/同步/记账
preload.js          contextBridge 安全桥（window.whaleAPI）
lib/
  balance.js        官方余额 API + 峰谷定价 + BalanceService（TTL 缓存）
  config.js         配置读写（%APPDATA%/whale-pet/config.json，env 覆盖）
  ledger.js         「小鲸鱼记账」：余额差值累计今日用量
  lines.js          随机台词池（lines.json）
  store.js          sql.js 存储层：schema + upsert + 查询
  usage-sync.js     平台私有接口 → 用量回填/分时/余额/账号指纹
renderer/
  pet.*             鲸鱼桌宠窗口（气泡/拖拽/命中区/呼吸动画）
  menu.*            设置窗口
  usage.*           用量统计面板（ECharts）
  echarts.min.js    图表库
test/               单元测试（node --test）
```

## 功能

- **桌宠**：透明置顶、点击穿透（setShape 只保留鲸鱼/气泡/按钮）、拖拽、Q 弹、低余额提醒、随机台词、峰谷提示
- **托盘**：「显示鲸鱼」勾选状态、立即刷新、打开设置、用量统计、开机自启、退出
- **设置**：API Key、平台令牌（自动登录提取）、主题、大小、音效、图片、台词等
- **用量统计**：历史日级回填、近 7/30/90/365 天或自定义日期、日级堆叠图 + 点击看分时、充值余额卡片、上次同步时间

## 数据与存储

- 配置：`%APPDATA%/whale-pet/config.json`（Windows，Linux/macOS 见 `lib/config.js`）
- 用量：`%APPDATA%/whale-pet/usage.db`（sql.js SQLite）
  - `amount_daily` / `cost_daily`：日级用量/费用
  - `hourly_usage` / `hourly_cost`：分时（平台只保留今天+昨天）
  - `meta`：账号指纹、余额快照、上次同步时间等

## 关键决策与踩坑（务必先读）

1. **用 sql.js 而不是 better-sqlite3**：better-sqlite3 v13 用 NAPI 10，需 Node≥22；Electron 34 内置 Node 20.18 只支持 NAPI 9，不兼容；降版本又因本机缺 ClangCL 编译失败。sql.js 是 WASM，零编译零 ABI 问题。
2. **`setShape` 必须传 `{x, y, width, height}` 且为整数**：传 `{w,h}` 或浮点会导致 shape 无效，整个窗口拦截鼠标（透明区「失效」）。见 `main.js sanitizeRects()`。
3. **气泡淡出后再裁剪窗口**：`hideBubble()` 里延迟 520ms 再 `reportShape()`，否则气泡被矩形边界硬切。
4. **分时数据平台只保留今天+昨天**：更早日期无分时，用量面板会提示「无分时数据」。
5. **「每轮花费」已移除**：DeepSeek 官网明示「数据可能有 5 分钟延迟」，余额差值无法精确到单轮，故该功能及 `turn_ledger`、`notify-bridge` 均已删除。
6. **`app.disableHardwareAcceleration()`**：桌宠图形简单，禁用硬件加速省约 260MB 内存（GPU 进程从 ~317MB 降到 ~54MB）。
7. **GMT+8**：平台用量按 GMT+8 分日桶，所有日期计算统一用 `TZ_OFFSET_SEC = 8*3600`（`lib/usage-sync.js`）。

## 打包与分发

- `build.win.target = ["nsis", "portable"]`：一次产出安装包 + 便携版。
- 安装包：NSIS 向导式（`oneClick:false`），`perMachine:false` 提供「仅当前用户 / 所有用户」选择页，`installerLanguages: ["zh_CN", "en_US"]` 中文优先，可选安装目录 + 桌面/开始菜单快捷方式。
- 产物分目录：`dist/installer/`（安装包 exe）、`dist/portable/`（便携版 exe + zip + win-unpacked）。
- 未做代码签名：SmartScreen 会提示「未知发布者」，需用户点「更多信息 → 仍要运行」。
- 打包联网下载 NSIS 工具链 / Electron 用 npmmirror 镜像（直接 GitHub 可能失败）。

## 常用命令

```bash
npm start            # 启动桌宠
npm test             # 跑单测（node --test）
npm run smoke        # 自动化冒烟测试（截图验证，约 20s 后退出）
npm run dist:win     # 打包（安装包 + 便携版）
```

## 单元测试注意

- `test/unit.test.js` 是原项目自带，其中「config 0600 文件权限」断言在 Windows 上必然失败（Unix 概念），属已知跨平台遗留，不影响功能。
- 其余 `test/store.test.js`、`test/usage-sync.test.js` 是本项目新增。
