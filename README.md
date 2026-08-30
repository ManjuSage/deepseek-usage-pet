# DeepSeek 用量小鲸鱼桌宠（DeepSeek Usage Pet）

![DeepSeek 小鲸鱼](assets/DSH2.png)

一只透明的桌面小鲸鱼，随时显示你的 DeepSeek **余额**与**今日消耗**，并内置**用量统计面板**（日级/分时图表、历史回填、充值余额、上次同步时间）。

基于 [momo-OwO-qwq/DeepSeek-Whale-Pet](https://github.com/momo-OwO-qwq/DeepSeek-Whale-Pet)（MIT）二次开发的独立改版项目，已与原项目分离。其中**用量统计功能**参照 [33March7/deepseek-api-usage-statistics](https://github.com/33March7/deepseek-api-usage-statistics) 实现。

## 特性

### 桌宠

- 🐋 透明置顶、无边框、无任务栏条目的浮动窗口，始终置顶
- 🖱️ 自由拖拽、方向感知锚点（窗口在左半屏时鲸鱼镜像贴左，可触及左右边缘）
- 🐋 点击穿透：窗口用 `setShape` 裁剪为鲸鱼/气泡/按钮区域，透明区点击直接落到桌面
- 🧸 按压 Q 弹 + 音效、呼吸动画、闲置半透明
- 💰 余额气泡：60 秒自动刷新、余额变化数字滚动、点击手动刷新、低余额系统通知
- 💬 随机台词 + 峰谷提示：点击鲸鱼弹余额，点气泡默认显示峰谷状态（随机台词已降频）

### 托盘

- 「显示鲸鱼」带勾选状态（实时反映可见性）
- 立即刷新 / 打开设置 / 用量统计 / 开机自启 / 退出

### 设置

- API Key、平台令牌（**自动登录提取** + 手动粘贴兜底）
- 外观 / 文案 / 音效 / 图片 / 随机台词 / 主题

### 用量统计（新增）

- 历史日级回填：用平台令牌从官网尽量回溯全部历史用量（30 天一段，遇连续空段停止）
- 日级堆叠图（按类型）+ 点击柱子下钻 24 小时分时
- 分时数据本地累积：每次同步保存「今昨」分时，日积月累可看更早分时（突破平台「只保留两天」的限制）
- 图表图例可交互：点击图例项（如「缓存命中 / 缓存未命中 / 输出 / 费用」）可**隐藏该项**，只看其余数据，再次点击恢复
- 范围选择：近 7 / 30 / 90 / 365 天 + 自定义日期
- 顶部卡片：总 tokens / 缓存命中 / 未命中 / 输出 / 请求次数 / 累计费用 / **充值余额**
- 启动自动同步：配置令牌后，启动及运行期间自动补同步（每小时检查、超 12h 轻量同步），可在设置关闭
- 同步进度与取消：历史回填会显示进度（「回填到 YYYY-MM-DD」），可中途取消
- 显示**上次同步时间**

## 快速开始

```bash
cd DeepseekAPIUsagePet
npm install
npm start
```

首次使用：

1. 右键鲸鱼 → 设置 → 填入 **API Key**（`sk-` 开头）即可显示余额。
2. 用量统计需要**平台令牌**：托盘 → 用量统计 → 点「登录平台获取令牌」，在弹出窗口中登录 DeepSeek 平台后自动抓取；也可以手动粘贴。
3. 点「立即同步」拉取历史用量。

## 使用

| 操作 | 效果 |
|---|---|
| 单击鲸鱼 | 弹出余额气泡并刷新 |
| 按住拖动 | 移动鲸鱼 |
| 点击气泡 | 显示峰谷状态（80% 概率）；小概率切随机台词；再点关闭 |
| 右键鲸鱼 / 悬停右上角汉堡按钮 | 打开设置 |
| 托盘「用量统计」 | 打开用量面板 |
| `Ctrl+Shift+R` | 全局刷新余额 |

## 配置与数据

所有数据保存在 `%APPDATA%/whale-pet/`（Windows；Linux/macOS 路径见 `lib/config.js`，可用环境变量 `WHALE_PET_HOME` 重定向）：

```text
whale-pet/
├── config.json    # 全部设置（含 API Key / platformToken）
├── usage.db       # sql.js SQLite：日级/分时用量、余额快照、上次同步时间
├── usage.json     # 记账账本（余额差值累计今日用量，跨天归档 30 天）
└── lines.json     # 随机台词池（首次自动生成）
```

## 目录结构

```text
DeepseekAPIUsagePet/
├── AGENTS.md / DESIGN.md / README.md   # 项目说明 / 设计文档 / 本文件
├── main.js / preload.js                # Electron 主进程 / IPC 安全桥
├── lib/
│   ├── balance.js     # 官方余额 API + 峰谷定价 + BalanceService
│   ├── config.js      # 配置读写（消毒 + 原子写 + 环境变量覆盖）
│   ├── ledger.js      # 小鲸鱼记账（余额差值）
│   ├── lines.js       # 随机台词池
│   ├── store.js       # sql.js 存储层（schema + upsert + 查询）
│   └── usage-sync.js  # 平台私有接口 → 用量回填/分时/余额/账号指纹
├── renderer/
│   ├── pet.*          # 鲸鱼桌宠窗口
│   ├── menu.*         # 设置窗口
│   ├── usage.*        # 用量统计面板（ECharts）
│   └── echarts.min.js # 图表库
├── assets/            # 鲸鱼素材 / 音效
└── test/              # 单元测试
```

## 打包与分发

支持两种 Windows 产物，`npm run dist:win` 一次生成（联网下载工具链建议走 npmmirror 镜像，避免直连 GitHub 失败）：

| 产物 | 位置 | 说明 |
|---|---|---|
| 安装包 | `dist/installer/` | NSIS 向导式安装：可选安装目录、可选「仅当前用户 / 所有用户」、中文界面、自动创建桌面与开始菜单快捷方式 |
| 便携版 | `dist/portable/` | 免安装：单文件 exe + zip（解压即用） |

> 安装包未做代码签名：首次双击时 Windows SmartScreen 会提示「未知发布者」，点「更多信息 → 仍要运行」即可。

> 打包使用 electron-builder 26；其部分二进制 npmmirror 镜像可能缺失，首次在本机打包需从 GitHub 手动补下载（见 [AGENTS.md](AGENTS.md)）。

## 开发

```bash
npm test         # 单元测试（node --test）
npm run smoke    # 自动化冒烟测试（窗口/托盘/点击/拖拽截图验证）
npm run dist:win # 打包（安装包 + 便携版）
```

更多架构细节、踩坑记录见 [AGENTS.md](AGENTS.md) 与 [DESIGN.md](DESIGN.md)。

## 说明

- **「每轮对话花费」已移除**：DeepSeek 官网明示「数据可能有 5 分钟延迟」，余额差值无法精确到单轮。
- 平台**分时数据只保留今天 + 昨天**，但本程序会本地累积保存，同步过的更早日期仍可看分时。
- 存储用 **sql.js（WASM）** 而非 better-sqlite3（原生模块有 NAPI 兼容问题）。
- 运行环境 **Electron 39**（已从 34 升级，修复运行时 CVE）。
- 已**禁用硬件加速**以降低内存占用（约省 260MB）。

## 与父项目 / 原版的差异

| 维度 | 父项目（DSH Web 插件） | 原版（momo 桌宠） | 本项目（改版） |
|---|---|---|---|
| 运行环境 | DSH Web 界面（注入页面） | 独立 Electron 桌面应用 | 独立 Electron 桌面应用 |
| 余额 | 官方 `/user/balance` | 官方 `/user/balance` | 官方 `/user/balance` |
| 今日已用 | 双模式（记账 / 令牌） | 双模式（记账 / 令牌） | 双模式 + **记账对账取大** |
| 每轮对话花费 | 监听 DSH 会话事件 | 不适用（独立应用） | **已移除**（余额 5 分钟延迟无法精确） |
| 用量统计 | 无 | 无 | **新增**（历史回填 / 日级·分时图表 / 充值余额 / 同步时间） |
| 平台令牌登录 | DSH 凭据服务 | 手动粘贴 | **登录窗自动提取** + 手动粘贴兜底 |
| 系统集成 | 无（依托 DSH） | 托盘 + 全局热键 + 通知 + 单实例 | 同左 + **显示/隐藏勾选** + **用量统计入口** |
| 点击穿透 | 页面透明区穿透 | `setShape` 窗口裁剪 | `setShape`（**修复 width/height 参数**）+ 命中区贴合轮廓 |
| 存储 | `$DSH_HOME/*.json` | `config.json` + `usage.json` | `config.json` + **sql.js SQLite**（`usage.db`） |
| 图表 | 无 | 无 | **ECharts** |
| 内存优化 | — | — | **禁用硬件加速** + 设置窗口按需创建 |

## 许可证

MIT License，见 [LICENSE](LICENSE)。鲸鱼素材与音效沿用原项目。

## 参考项目

- [MeteorNOX/DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)（MIT）：DSH Web 插件，鲸鱼余额挂件的原始来源
- [momo-OwO-qwq/DeepSeek-Whale-Pet](https://github.com/momo-OwO-qwq/DeepSeek-Whale-Pet)（MIT）：基于上述挂件实现的独立桌宠版，本项目在此基础上改版
- [33March7/deepseek-api-usage-statistics](https://github.com/33March7/deepseek-api-usage-statistics)：用量统计的私有接口与存储 schema
