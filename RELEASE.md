# 发布准备

当前状态：**源码已进 GitHub 仓库 `66-zhimeng/dsh-dispatch`，尚未发 npm、尚未进任何插件市场索引。**

## 1. 为什么还差两步

| 步骤 | 卡在哪 |
| --- | --- |
| `npm publish` | 本机 `npm whoami` → `ENEEDAUTH`，没有 npm 登录态；包里也还留着 `"private": true` |
| 上传插件市场 | `plugin_market` 的索引列表为空（`indexes: []`），本机没有配置任何市场源可以接收上传 |

插件市场的索引大多数是 npm 包或指向仓库的 JSON，所以顺序通常是：先 npm 发布 → 再把包名登记到市场的索引里。

## 2. GitHub（已完成）

```powershell
gh repo view 66-zhimeng/dsh-dispatch --json name,visibility,url
```

更新代码：

```powershell
cd D:\work\aigc-media\modules\dsh-dispatch
git add -A; git commit -m "…"; git push
```

## 3. 发 npm 之前

- [ ] `npm login`（或把 token 放进 `~/.npmrc`；不要提交进仓库）
- [ ] 删掉 `package.json` 里的 `"private": true`
- [ ] 加 `license`（现在是空的，npm 会警告）
- [ ] 补 `repository` / `homepage` 指向 GitHub 仓库
- [ ] `npm test` 与 `npm run test:kernel` 全绿
- [ ] 确认版本号：当前 `0.2.0`

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

## 4. 发完之后怎么装

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml
- insert:
    - id: tool-dispatch          # 换代码时必须改这个 id，否则热挂载不会换实例
      name: dsh-dispatch
      config:
        telemetryPath: C:\Users\<you>\.dsh\dsh-dispatch\telemetry.jsonl
```

## 5. 已知的坑（发布前必读）

- **只改 `name` 不换 `id`**：旧实例被卸载、新实例不注册，`run_tools` 从工具列表消失。换代码一定连 `id` 一起换。
- **`package.json` 带 BOM**：Loader 解析失败，entry 变 `inactive`，表现和上一条一模一样。Windows 上用 `Set-Content -Encoding utf8` 会写 BOM，改用 `[IO.File]::WriteAllText(..., New-Object System.Text.UTF8Encoding($false))` 或 node 的 `fs.writeFileSync`。
- **热挂载不认 mtime**：`touch` 配置文件通常不够，要真的改动内容（或换 `id`）。
