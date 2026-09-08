/**
 * Clash 客户端探测（tools 层）：GET /version 探活 + 内核识别 + /configs 读混合口
 * 依赖方向：依赖 ./adapter 与 ../errors；被 optimizer（ClashService）调用
 * 设计思路：探测失败不抛业务错（返回 detected=false 由面板引导）；仅 401 视为鉴权错误抛出
 */
import { HttpError } from '../../infrastructure/http'
import type { ClashAdapter } from './adapter'
import { ToolError, TOOL_ERROR_CODES } from '../errors'
import type { ClashDetectResult, ClashKernel } from './types'

/**
 * 探测本机 Clash 客户端
 * @param adapter external-controller 适配器
 * @returns detected=false 表示未检测到（连接失败/未开启外部控制）；401 时抛 CLASH_AUTH_FAILED
 */
export async function detectClash(adapter: ClashAdapter): Promise<ClashDetectResult> {
  let version: Record<string, unknown>
  try {
    version = await adapter.version()
  } catch (e) {
    if (e instanceof HttpError && e.status === 401) {
      throw new ToolError(400, TOOL_ERROR_CODES.CLASH_AUTH_FAILED, 'Clash 外部控制鉴权失败（请检查 clash.apiSecret 配置）')
    }
    return { detected: false, kernel: null, mixedPort: null }
  }
  const kernel: ClashKernel = version.meta === true ? 'mihomo' : 'generic'
  let mixedPort: number | null = null
  try {
    mixedPort = await adapter.mixedPort()
  } catch {
    mixedPort = null
  }
  return { detected: true, kernel, mixedPort }
}
