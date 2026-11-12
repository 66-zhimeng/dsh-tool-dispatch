# 稳定性测试：PTC 模式下的并发子调用（v0.2.8）

2026-11-12 00:42–00:46 UTC，在真实 PTC 会话里跑的四轮压力测试。目的是验证 v0.2.8 的「parent 直派」路径在几十到上百路并发下是否稳定。

## 环境

| 项 | 值 |
| --- | --- |
| 会话 | `session-079f1133-5bf5-48e0-a19c-8a2481c6bad9`（`agentPreset: ptc`，顶层工具只有 `run_code`） |
| 模型 | `deepseek-v4.1-flash`（`reasoningEffort: max`） |
| 工作目录 | `D:\work\aigc-media` |
| 系统 | Windows 11，PowerShell 7 |
| 调用方式 | `run_code` 程序里只调一次 `await tools.run_tools({ steps, maxSteps, maxParallel, stopOnError: false })` |

每一轮的子调用都是 `pwsh`：`Start-Sleep -Milliseconds N; 'ok-i'`。这样单步耗时可控，不会被网络或磁盘干扰。

## 结果

| 轮次 | 负载 | 子调用 | 成功 / 失败 | `totalMs` | 单步 min / max / avg | 串行估算 | 加速 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 60 × `sleep 1.5s` | 60 | 60 / 0 | **4,164 ms** | 2,717 / 4,145 / 3,355 ms | ≈ 90 s | 21.6× |
| 2 | 100 × `sleep 1s`，`maxParallel: 100` | 100 | 100 / 0 | **5,341 ms** | 1,655 / 5,318 / 3,929 ms | ≈ 100 s | 18.7× |
| 3 | 60 × `sleep 1.5s`（第 1 轮重复） | 60 | 60 / 0 | **4,059 ms** | 2,723 / 4,045 / 3,237 ms | ≈ 90 s | 22.2× |
| 4 | 60 步 + 故障注入（每 10 步一条 `exit 3`） | 60 | 54 / **6** | **3,523 ms** | 1,558 / 3,510 / 2,801 ms | ≈ 57 s | 16.2× |

第 4 轮失败的下标是 `[9, 19, 29, 39, 49, 59]`，与预期完全一致；失败的步骤带 `[exit code: 3]`，其余 54 步照常完成（`stopOnError: false`）。

## 观察

- **总耗时 ≈ 单步最大耗时**，四轮都成立。说明子调用是真的同时在跑，而不是排队后顺序完成。
- **没有一次失败**（前三轮 220/220），也没有超时、没有 `UNKNOWN_TOOL`。
- **规模上限来自进程启动**，不是调度器：100 路时单步从 1s 被拉到 1.6–5.3s，多半是同时 spawn 100 个 pwsh 的开销。50–100 路是舒服的区间。
- `run_code` 自身的墙钟比 `run_tools.totalMs` 多 0.2–0.6 s，那是程序启动与结果序列化的固定开销。
- 重复跑第 1 轮（第 3 轮）两次结果相差 105 ms（4,164 vs 4,059），可重复性良好。

## 复现

```js
const r = await tools.run_tools({
  steps: Array.from({ length: 60 }, (_, i) => ({
    tool: 'pwsh',
    arguments: { command: `Start-Sleep -Milliseconds 1500; 'ok-${i}'`, description: `probe ${i}` },
  })),
  maxSteps: 64,
  maxParallel: 60,
  perStepChars: 30,
  stopOnError: false,
  totalTimeoutMs: 300000,
});
console.log(r.totalMs, r.steps.filter((s) => s.ok).length);
```

## 已知限制

这条路径依赖两个内部接口：`ctx.tools.selectExecutor(agent).pipeline` 与它上面的 `prepare / dispatch / complete`。DSH 升级如果改了这几处，`run_tools` 会自动回退到 `ctx.tools.execute`（standard 预设一直走这条），PTC 下的并发能力则暂时失效——回退不会报错，只是变回串行。


## 回退路径（v0.2.9）

v0.2.8 的并发依赖 `ctx.tools.selectExecutor(agent).pipeline`。拿不到它时，`run_tools` 会退回 v0.2.7 的 `ctx.tools.execute()` 入口。为验证这条分支，v0.2.9 加了两个东西：

- 插件配置 `forceFallback: true`——强制跳过 pipeline（只影响开关，不改派发逻辑）；
- 返回对象与 telemetry 增加 `via` 字段（`nested` = 走 pipeline，`execute` = 走回退），分支判定改成每批决策一次。

三组实测（同一会话、同一负载形态）：

| 场景 | `via` | 子调用 | 成功 / 失败 | `totalMs` | 单步 ms |
| --- | --- | --- | --- | --- | --- |
| PTC + `forceFallback` | `execute` | 20 | 0 / 20 | 8 | 2–8 |
| standard + `forceFallback` | `execute` | 3 | 3 / 0 | 1,263 | 1,258–1,262 |
| PTC 走 pipeline（对照） | `nested` | 20 | 20 / 0 | 1,448 | 1,105–1,444 |

结论：

- **分支确实切过去了**：`via` 与 telemetry 两处都记录为 `execute`，不是靠推断。
- **回退在 execute 可用的环境里功能完整**：standard 下 3/3 成功、仍然并发（1.26 s 跑完 3 条 1 s 命令）。
- **PTC 下回退是「安全失败」**：每步立刻返回 `UNKNOWN_TOOL: unknown tool "pwsh": only \`run_code\` is callable directly`，8 ms 内结束，不挂起、不超时、不丢步骤、不污染会话。这是内核规则（`dsh-tools/lib/types/contracts.d.ts:184-186`），不是插件的缺陷。
- 因此 `forceFallback` 只用于诊断与演练；PTC 里不要关掉 pipeline。
