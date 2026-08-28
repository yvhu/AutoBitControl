// 控制台 UTF-8 设置（跨 shell 安全）：
// PowerShell/cmd 下 chcp 是内置命令，Git Bash 下 chcp.com 在 PATH 中，
// 用 Node 子进程调用统一处理，避免 cmd 的 >nul 语法在 sh 下创建 junk 文件
import { spawnSync } from 'node:child_process'

if (process.platform === 'win32') {
  spawnSync('chcp', ['65001'], { stdio: 'ignore' })
}
