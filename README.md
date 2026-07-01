# vscodexkit

`vscodexkit` 是一个非官方的 OpenAI Codex VSCode 扩展辅助工具。

它只修改本机已安装的 VSCode Codex 扩展，不修改 Codex CLI，不修改
VSCode 用户数据、工作区数据或项目文件。

## 功能

- Windows 系统级通知：任务完成、失败、需要审批、需要用户输入。
- 自动 Retry：当 stream 重试耗尽导致失败时，自动重新发送 retry。
- 过滤用户手动中断，避免手动停止任务后误报完成或失败通知。
- 每个扩展版本只保存一份干净原版基线：`.codexpatch/original`。

## 使用

从 GitHub 克隆项目：

```powershell
git clone https://github.com/aikavvak12una/vscodexkit.git
cd vscodexkit
node .\bin\vscodexkit.js apply
```

`apply` 默认开启通知和自动 Retry。可以用参数调整：

```powershell
node .\bin\vscodexkit.js apply --no-notify
node .\bin\vscodexkit.js apply --no-auto-retry
node .\bin\vscodexkit.js apply --notify --auto-retry
```

卸载并恢复原版扩展：

```powershell
node .\bin\vscodexkit.js uninstall
```

默认会自动查找最新的 Codex VSCode 扩展目录：

```text
%USERPROFILE%\.vscode\extensions\openai.chatgpt-*
```

也可以指定扩展目录：

```powershell
node .\bin\vscodexkit.js apply --extension-dir "C:\Users\<you>\.vscode\extensions\openai.chatgpt-<version>-win32-x64"
```

执行 `apply` 或 `uninstall` 后，需要重新加载 VSCode。

## 安全机制

`apply` 会在安装后自动检测补丁状态。  
如果 patch 或检测失败，脚本会在控制台输出异常，并从干净原版基线恢复扩展。

`uninstall` 会恢复原版扩展，并删除 `.codexpatch` 状态目录。

Codex VSCode 扩展更新后，需要重新运行 `apply`。脚本会自动选择最新扩展目录，
并为新版本生成新的原版基线。脚本不会随 VSCode 启动自动运行。
