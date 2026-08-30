/**
 * 进程入口：仅负责启动应用
 * 设计思路：void 调用避免顶层 await 的 promise 处理警告（异常由 app 内的进程级处理器兜底）
 */
import { startApp } from './app'

void startApp()