/**
 * 进程入口：仅负责启动应用
 * 设计思路：void 调用避免顶层 await 的 promise 处理警告（异常由 app 内的进程级处理器兜底）
 */
// src/index.ts 最顶部
import { spawn } from 'child_process';
import { startApp } from './app'

// 1. 强制设置环境变量（影响 pino-pretty 和 tsx 的子进程）
process.env.LANG = 'en_US.UTF-8';
process.env.LC_ALL = 'en_US.UTF-8';

// 2. 强制设置 stdout/stderr 的编码（解决 pino 内部流乱码）
if (process.stdout.setDefaultEncoding) {
  process.stdout.setDefaultEncoding('utf8');
}
if (process.stderr.setDefaultEncoding) {
  process.stderr.setDefaultEncoding('utf8');
}
void startApp()
