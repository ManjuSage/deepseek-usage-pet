# 桌宠表情状态机 · 落地设计

> 状态：已实现（阶段 A / B / C 全部完成）
> 日期：2026-09-07
> 参考：MeteorNOX/DeepSeek-Balance-Whale-Widget 的 `For–WinDesktop` 分支（表情/眨眼/心情状态机）

## 1. 目标

把桌宠从「一张主图 + 可选预警图」升级为**有表情、会眨眼、有性格**的宠物，同时保持现有余额/用量/托盘/设置能力与点击交互不变。

## 2. 决策摘要

- 表情图**直接采用父项目**的 8 张图。
- 所有表情台词（生气/失望/孤独/害羞/疲惫）**均可编辑**。
- **保持现有点击逻辑**：单击 = 余额，点气泡 = 峰谷/台词，不引入点击序列。
- 「预警换图」与「疲惫表情」**合并为一个「低余额表情」**，放在表情区。
- 低余额提示台词：**每 5 分钟**轮播一条。
- 低余额系统通知：节流**保持 30 分钟**不变。

## 3. 配置字段（`lib/config.js`）

新增 `expressions` 对象：

```js
expressions: {
  images: {
    press:         '',  // 摸头（按压）
    angry:         '',  // 生气
    disappointed:  '',  // 失望
    shy:           '',  // 害羞
    exhausted:     '',  // 低余额表情（合并原预警图）
    blinkHalf:     '',  // 半闭眼
    blinkClosed:   '',  // 闭眼
    blinkHalfOpen: '',  // 半睁眼
  },
  enabled: {
    blink: true,
    angry: true,
    disappointed: true,
    shy: true,
    exhausted: true,
  },
  lines: {
    angryWarn:         ['你再摸人家就生气了喵 (╬ Ò﹏Ó)'],
    disappointedEntry: ['鲸鲸没人要了喵 (╥﹏╥)'],
    lonely:            [ /* 18 条孤独台词，可编辑 */ ],
    shy:               ['主人摸本鲸头了喵 (≧◡≦)♡'],
    exhausted:         [ /* 6 条疲惫台词，可编辑 */ ],
  },
  blinkMinSec: 4,
  blinkMaxSec: 6,
  idleToDisappointedSec: 180,
  hoverToShyMs: 1500,
  shyDurationMs: 10000,
  angryDurationMs: 5000,
  exhaustedPromptSec: 300,   // 低余额提示：每 5 分钟（300 秒）一条
}
```

- **低余额阈值**：沿用现有 `lowBalanceThreshold`，不重复建字段。
- **旧字段迁移**：`alertImage` / `alertImgPath` 废弃；在 `sanitize()` 里做兼容——若旧配置有 `alertImgPath` 且新 `expressions.images.exhausted` 为空，自动映射过去。

## 4. 表情图资源

把父项目 `frontend/assets/images/` 下的图复制进本项目 `assets/expressions/`：

| 用途 | 父项目文件 |
|---|---|
| 默认主图（沿用现有 mainImgPath） | `main.png` |
| 按压/摸头 | `stroking.png` |
| 生气 | `angry.png` |
| 失望 | `disappointed.png` |
| 害羞 | `shy.png` |
| 疲惫/低余额 | `exhausted.png` |
| 半闭眼 | `half_closed_eyes.png` |
| 闭眼 | `close_eyes.png` |
| 半睁眼 | `half_open_eyes.png` |

> 素材来自父项目，需在 README / 参考项目里补一句素材来源与许可说明（父项目 README 也注明「请参照原仓库许可」）。

## 5. 表情状态机（`renderer/pet.js`）

- `mood`：`normal | angry | disappointed | shy | exhausted`，外加 `blinking` 标志。
- 显示优先级：`mood 表情 > 按压 press > 眨眼帧 > 主图`。
- `setExpression()` 只换 `img.src`，不碰 transform（左右镜像继续生效）。
- 各状态进入时清掉其它定时器，退出时恢复 + 重新排期。

## 6. 触发条件

| 行为 | 触发 | 表现 | 退出 |
|---|---|---|---|
| 眨眼 | normal 下随机 4~6s | 半闭 → 闭 → 半睁 三段换图 | 自动 |
| 生气 | 10s 内点击 ≥5 次警告、≥18 次生气 | angry 图 + 可编辑警告台词 | 5s |
| 失望 | 空闲 3 分钟 | disappointed 图 + 每 30s 轮播孤独台词 | 点击/拖拽恢复 |
| 害羞 | 悬停鲸鱼 1.5s | shy 图 + 可编辑台词 | 10s |
| 低余额表情 | 余额 < `lowBalanceThreshold` | exhausted 图 + 每 5 分钟轮播疲惫台词 | 余额回到阈值以上 |

## 7. 设置界面（`renderer/menu.html` + `menu.js`）

新增「表情」分区，并把原「图片」页的「预警换图」挪进来、与疲惫表情合并：

- 每个表情：**开关 + 上传图片 + 恢复默认**。
- 词池编辑：生气警告、失望入口、孤独台词、害羞、疲惫台词（可增删列表）。
- 参数：眨眼间隔、空闲进失望、悬停进害羞、疲惫提示间隔（默认 5 分钟）。
- 低余额阈值仍留在原「数据」页（与现在一致）。

## 8. 与现有功能整合

- **点击逻辑完全不变**：单击 = 余额，点气泡 = 峰谷/台词。
- **低余额换图合并**：原「预警换图」和「疲惫表情」合成一个「低余额表情」，触发后换图 + 每 5 分钟冒泡疲惫台词。
- **系统通知**：保留现有一次性系统通知，节流保持 30 分钟。
- **镜像 / Q弹 / 音效**：不受影响，表情只换图。

## 9. 落地顺序

1. **阶段 A**：配置字段 + 8 张图 + 状态机骨架；先做「眨眼 + 失望（孤独台词）+ 生气」。
2. **阶段 B**：补「害羞 + 低余额表情（合并预警图）」，并做设置页 UI（开关 / 上传 / 词池编辑）。
3. **阶段 C**：参数全部可配、旧字段迁移、补 README 素材许可说明。
