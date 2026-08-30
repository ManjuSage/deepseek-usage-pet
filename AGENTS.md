# AGENTS.md — 项目说明

给后续的 AI Agent 或开发者快速了解本项目。改动前先读这里。

## 一句话

这是一个**独立改造版**的 DeepSeek 桌面鲸鱼桌宠：在透明置顶鲸鱼（余额气泡 + 拖拽 + Q 弹）基础上，扩展了**托盘**、**平台令牌登录**、**用量统计面板**（历史回填 + 日级/分时图表 + 余额 + 同步时间）。已与原项目 [momo-OwO-qwq/DeepSeek-Whale-Pet](https://github.com/momo-OwO-qwq/DeepSeek-Whale-Pet) 分离，是另一个项目。

## 技术栈

- Electron `^39.0.0`
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

1. **用 sql.js 而不是 better-sqlite3**：better-sqlite3 原生模块有 NAPI 版本兼容问题，且本机缺 ClangCL 编译失败。sql.js 是 WASM，零编译零 ABI 问题。
2. **`setShape` 必须传 `{x, y, width, height}` 且为整数**：传 `{w,h}` 或浮点会导致 shape 无效，整个窗口拦截鼠标（透明区「失效」）。见 `main.js sanitizeRects()`。
3. **气泡淡出后再裁剪窗口**：`hideBubble()` 里延迟 520ms 再 `reportShape()`，否则气泡被矩形边界硬切。
4. **分时数据平台只保留今天+昨天**：程序每次同步把「今昨」分时 upsert 进 SQLite 并持续累积，面板能显示已累积的更早分时（前提是该日期在两天窗口内同步过）；没存到的日期才提示「无保存的分时数据」。
5. **「每轮花费」已移除**：DeepSeek 官网明示「数据可能有 5 分钟延迟」，余额差值无法精确到单轮，故该功能及 `turn_ledger`、`notify-bridge` 均已删除。
6. **`app.disableHardwareAcceleration()`**：桌宠图形简单，禁用硬件加速省约 260MB 内存（GPU 进程从 ~317MB 降到 ~54MB）。
7. **GMT+8**：平台用量按 GMT+8 分日桶，所有日期计算统一用 `TZ_OFFSET_SEC = 8*3600`（`lib/usage-sync.js`）。
8. **记账模式「对账取大」**：配置了平台令牌时，记账模式每次刷新用「余额差值 vs 平台今日用量」取较大值，补齐未运行期间的花费；未配令牌则只有余额差值（会漏掉当天首次启动前已产生的花费）。
9. **启动自动同步**：启动时 + 每小时检查一次，距上次同步超 12h 且配置令牌就做一次「轻量同步」（近两天日级 + 今昨分时 + 余额，不含历史回填）；设置里 `autoSync` 可开关。
10. **SQLite 批量落盘**：`store.beginBatch()/flush()` 让一次同步只全库导出落盘一次，避免每行写都 export。
11. **模型定价精确匹配**：`priceFor` 精确匹配，未知模型走默认价并打英文日志（避免 GBK 终端乱码）。注意平台会把旧版 chat/reasoner 合并成 `deepseek-chat & deepseek-reasoner` 一个名字。
12. **安全加固**：`config:get` 对非设置窗口掩码密钥；`shell:open-path` 白名单；登录窗限制导航/弹窗/权限；原始响应存档上限 100 份（目录 0700 / 文件 0600）。
13. **CSP 收紧**：pet/menu/usage 三页补 `object-src 'none'; base-uri 'none'; connect-src 'none'`。

## 打包与分发

- `build.win.target = ["nsis", "portable"]`：一次产出安装包 + 便携版。
- 安装包：NSIS 向导式（`oneClick:false`），`perMachine:false` 提供「仅当前用户 / 所有用户」选择页，`installerLanguages: ["zh_CN", "en_US"]` 中文优先，可选安装目录 + 桌面/开始菜单快捷方式。
- 产物分目录：`dist/installer/`（安装包 exe）、`dist/portable/`（便携版 exe + zip + win-unpacked）。
- 未做代码签名：SmartScreen 会提示「未知发布者」，需用户点「更多信息 → 仍要运行」。
- 打包联网下载 NSIS 工具链 / Electron 用 npmmirror 镜像（直接 GitHub 可能失败）。
- electron-builder 26 需要下载 `icons` / `nsis` / `7zip` / `nsis-resources` 等二进制，npmmirror 镜像可能缺（404），需从 GitHub 手动下载放进 `%LOCALAPPDATA%\electron-builder\Cache`。

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
