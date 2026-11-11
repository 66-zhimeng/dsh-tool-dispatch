# 发布与分发

## 当前状态

| 通道 | 状态 |
| --- | --- |
| GitHub 源码 | ✅ `https://github.com/66-zhimeng/dsh-dispatch`（main） |
| 插件市场索引 | ✅ 已上线：`https://raw.githubusercontent.com/66-zhimeng/dsh-plugins/main/market/index.json`（`source.type = git`，固定 commit） |
| npm | ⏸ 未发布 —— 名字 `dsh-dispatch` 已被占用（他人 0.4.0），且本机无 npm 登录态 |

**分发就走 Git 源**，市场索引里那条已经能用；npm 只是将来的第二条通道。

## 1. 市场索引（当前的分发方式）

索引在 `66-zhimeng/dsh-plugins` 仓库的 `market/index.json`，格式 1，`source`：

```json
{ "type": "git", "url": "https://github.com/66-zhimeng/dsh-dispatch", "commit": "<40 位 SHA>" }
```

发新版本 = 推代码 → 把 `commit` 换成新 SHA → `parseMarketIndex` 校验 → 提交索引仓库。DSH 侧按 `cacheTtlMs` 缓存索引（本机 profile 已调成 60s）。

注册索引源（profile 的 `cordis.patch.yml`）：

```yaml
- id: plugin-market
  config:
    indexes:
      - https://raw.githubusercontent.com/66-zhimeng/dsh-plugins/main/market/index.json
```

## 2. 以后要发 npm

前提（两条都要满足）：

1. **换名字**：`dsh-dispatch` 在 npm 上已存在（0.4.0）。可用且当前未占用的候选：
   - `@66-zhimeng/dsh-dispatch`（scope 属于账号本身，改名后仓库名不用动）
   - `dsh-tool-dispatch`（无 scope）
2. **登录**：`npm login --auth-type=web`，或在 npmjs.com 建 Automation token 写进 `~/.npmrc` 的 `//registry.npmjs.org/:_authToken=…`（别提交进仓库）。

改完名字后要同步的地方：`package.json` 的 `name`、已装目录名、profile patch 里的 `id` 与 `name`（`id` 必须换，否则热挂载不换实例）。

```powershell
cd D:\work\aigc-media\modules\dsh-dispatch
npm test
npm run test:kernel
npm publish --access public
```

`test:kernel` 依赖 `DSH_PKG_BASE`，默认指向本机 DSH 安装位置：

```powershell
$env:DSH_PKG_BASE = "file:///D:/Tools/PiAgent/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai"
```

发成功后，把索引里的 `source` 换成 `{"type":"npm"}`，安装参数自动变成 `dsh-dispatch@0.2.0`。

## 3. 手工安装

```powershell
Copy-Item "D:\work\aigc-media\modules\dsh-dispatch" "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-dispatch" -Recurse
```

```yaml
- insert:
    - id: tool-dispatch          # 换代码时必须改这个 id
      name: dsh-dispatch
      config:
        telemetryPath: C:\Users\<you>\.dsh\dsh-dispatch\telemetry.jsonl
```

## 4. 排障备忘

- **只改 `name` 不换 `id`**：旧实例被卸载、新实例不注册，`run_tools` 从工具列表消失。换代码一定连 `id` 一起换。
- **`package.json` 带 BOM**：Loader 解析失败，entry 变 `inactive`，表现同上。Windows 上 `Set-Content -Encoding utf8` 会写 BOM，改用 `[IO.File]::WriteAllText(..., New-Object System.Text.UTF8Encoding($false))` 或 node 的 `fs.writeFileSync`。
- **热挂载不认 mtime**：`touch` 配置文件通常不够，要真的改动内容（或换 `id`）。
- **市场索引有缓存**：默认 `cacheTtlMs` 600000（10 分钟）；改索引后要么等，要么把 `indexes` 删掉重存一次强制重抓。
