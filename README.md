# dsh-dispatch

给 DeepSeek Harness 加两个工具，把「很多次模型往返」压成「一次往返」。单步往返的固定成本（本机实测 TTFT 中位 3.0s、整步中位 5.7s）是这里唯一要消灭的东西。

| 工具 | 解决什么 | 代价 |
| --- | --- | --- |
| `run_tools` | 一次模型往返里执行多个工具调用（读 3 个文件、跑 2 条命令、抓 4 个网页） | 这一步的模型输出变长（要写 N 组参数） |
| `run_parallel` | 一次往返把 N 个互不依赖的子任务派给 N 个子 agent 真并行 | 子 agent 各自烧 token |

---

## 一、它是怎么加速的

### 1. 一次往返里到底在等什么

一个 step 的墙钟 ≈ **首字延迟（TTFT）** + **生成输出 token** + **工具执行**。

本机实测（同一台机器、同一模型、20 个会话 982 个 step）：

| 分量 | 数值 | 占单步 |
| --- | --- | --- |
| TTFT（等到第一个 token） | p50 **3.0s** / p90 4.3s | 约 36% |
| 生成（含思考） | 输出 p50 611 tok ÷ 195 tok/s ≈ 3.1s | 约 45% |
| 工具执行 | p50 **0.56s** | 约 19% |

TTFT 与上下文长度几乎无关（36k 上下文 1,988ms、105k 上下文 2,346ms），所以它是一笔**按次数收的固定费**，不是「上下文太长拖慢的」。

### 2. 分开做 vs 合批：公式

```
分开做（N 个动作）≈ N × (TTFT + 生成 + 单个工具)
合批（一次 run_tools）≈ 1 × (TTFT + 生成(N 组参数) + max(工具))   ← 工具默认并发
```

省下来的是两块：

- **N−1 次 TTFT**：每少一次往返就少等一次首字；
- **工具串行改并发**：`sum(工具)` 变成 `max(工具)`。

代价是这一轮模型要多写 N 组参数（输出 token 变多），以及**单步超时必须够长**（默认 60s，`stepTimeoutMs` 可调）。

### 3. 为什么必须由插件来做

一次模型输出里能带几个 `tool_call` 由模型决定，执行侧改不了；但**内核原本还会把独占工具逐个串行执行**（`dsh` 的 `batch.js` 对非并发安全工具分组长度为 1）。本插件在工具内部拿到 `ctx.tools.execute`，把 N 个调用重新派发成并发 —— 这是「一次往返里真的让多个动作同时跑」的关键，纯提示词做不到。

---

## 二、什么情况下快多少

### 工具侧（实测，本机，`pwsh` 每条 `Start-Sleep 1`）

| 形状 | 串行本应 | 实测 | 说明 |
| --- | --- | --- | --- |
| 4 条独立命令 | ~4.0s | **1,315ms** | 默认并发 |
| 8 条独立命令 | ~8.0s | **1,451ms** | 默认上限 8 |
| 8 条 + `maxParallel: 4` | ~8.0s | **2,608ms** | 分两波 |
| 3 条 `after` 链 | ~3.0s | **3,777ms** | 依赖链不省工具时间 |
| 6 个快工具（read/grep/glob） | ~0.9s | **186ms** | 并发后只剩最慢那个 |

### 端到端（模型往返 + 工具）

| 场景 | 分开做 | 一次 `run_tools` | 提速 |
| --- | --- | --- | --- |
| 3 条各 2 秒的命令 | 30.4s（3 次往返） | **4.1s**（1 次） | **7.4×** |
| 4 个文件读（工具很快） | 13.2s（4 次往返） | **8.15s**（1 次） | 1.6× |

两者的差距说明一件事：**工具越慢、动作越多，收益越大**。读文件这类毫秒级动作，省下来的几乎全是往返；而每次往返本身还有 3s 首字 + 一段思考，所以 N=4 时只有 1.6×。

### 每动作的模型时间（本机 5,953 个历史 step）

| 每步承载的动作数 | 单步均值 | 折算每动作 |
| --- | --- | --- |
| 1 个 | 8.8s | **8.8s** |
| ≥2 个 | 12.4s | **6.2s** |

即：合批把每次动作的模型开销从 8.8s 压到 6.2s（−30%），因为固定成本被摊薄了。

---

## 三、什么时候不该用

- **有依赖关系**：B 需要 A 的产物时，用 `after: [0]` 声明，别硬塞进同一个并发波次。
- **必须看结果才知道下一步**（浏览器点一下看一眼、逐步调试）：合批没有收益，收益本来就为零。
- **只有一个动作**：直接调用原工具，包一层只会多一次参数序列化。
- **单步会超过 `stepTimeoutMs`**（默认 60s）：要么调大，要么放后台。

---

## 四、踩过的坑与修复

| 问题 | 现象 | 修复 |
| --- | --- | --- |
| 退出码被当成功 | `throw` / 非零退出的 `pwsh` 返回 `ok`，`stopOnError` 看不到失败 | 解析结果文本里的 `[exit code: N]`，非零判失败；可用 `exitCodeIsError: false` 关掉 |
| 独占工具被串行 | 两条 `pwsh` 在同一个 `run_tools` 里仍然一前一后（12.5s） | 插件内自行并发派发，实测 3×3s 从 9,030ms → 3,010ms |
| 并发打乱顺序 | 编译还没结束就去读产物 | 每步可声明 `after`（只能指向更早的步，从结构上排除环） |
| 浏览器/提问被并发 | 同一页面多条指令互相踩、提问重复弹出 | `dsh_browser_*`、`ask_user_question`、`todo_write` 恒定独占，等批内其他调用跑完再上 |
| 换代码不热更新 | 只改 `name` 时旧实例卸载、新实例不注册，工具直接消失 | patch 里的 `id` 必须跟着换（`tool-dispatch` → 下一个版本名） |
| 模块加载失败但无提示 | `package.json` 带 UTF-8 BOM → Loader 解析失败，entry 变 `inactive`，`run_tools` 从工具列表消失 | 用无 BOM 的 UTF-8 写这些文件（PowerShell 5.1 的 `Set-Content -Encoding utf8` 会加 BOM） |
| 子 agent 的 `maxParallel` 形同虚设 | safe 6 路 `maxParallel: 4`，6 个会话仍在 135ms 内全部创建 | 子 agent 派发即返回，真正上限是任务数 8；已在文档写明，不假装排队 |

---

## 五、安装

```powershell
Copy-Item "D:\work\aigc-media\modules\dsh-dispatch" "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-dispatch" -Recurse
```

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml
- insert:
    - id: tool-dispatch          # 换代码时必须改这个 id
      name: dsh-dispatch
      config:
        telemetryPath: C:\Users\<you>\.dsh\dsh-dispatch\telemetry.jsonl
```

保存即热挂载，**不需要重启**。工具名固定为 `run_tools` / `run_parallel`。

---

## 六、用法

```jsonc
{
  "steps": [
    { "tool": "pwsh", "arguments": { "command": "pnpm build" } },
    { "tool": "read", "arguments": { "file_path": "dist/index.js" }, "after": [0] },
    { "tool": "grep", "arguments": { "pattern": "TODO", "path": "src" } }
  ]
}
```

第 1、3 步同时跑，第 2 步等第 1 步完成。

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `steps[].after` | — | 数字或数组，指向更早的步；声明了才等待 |
| `maxParallel` | 8 | 同时最多几个步骤在飞 |
| `stopOnError` | true | 失败后不再启动新步骤（已在飞的不打断） |
| `stepTimeoutMs` | 60000 | 单步超时 |
| `totalTimeoutMs` | 180000 | 整批超时 |
| `perStepChars` | 800 | 每步结果回给模型的字符上限 |
| `exitCodeIsError` | true | 文本里出现非零 `[exit code: N]` 时判失败 |

`run_parallel`：`tasks: [{description, prompt}]`，最多 8 个，`maxParallel` 默认 8。

---

## 七、限制

- 只减少**往返次数**，不减少工具本身的耗时；单个慢工具（例如 60s 的构建）不会因为合批变快。
- 并发上限受模型侧影响：一次派太多次，上游可能排队（实测 8 路子 agent 中有一个首字等了 34.8s，是上游延迟不是插件排队）。
- 加速不是自动的：模型得真的把多个动作塞进一次 `run_tools`。一次只发一个调用时，和没有这个插件完全一样。
- 只作用于**本 profile** 的会话。
