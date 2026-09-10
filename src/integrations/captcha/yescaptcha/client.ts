/**
 * yescaptcha 原始 API 客户端（integrations/captcha/yescaptcha 层）：createTask/getTaskResult/getBalance
 * 依赖方向：依赖 infrastructure/http 与 provider 的 CaptchaFailure，被本平台 provider 使用
 * 设计思路：只做协议封装不做编排（串行排队/轮询超时在 provider 层）
 * 官方出处（计划核对总表）：createTask=wiki 33351、getTaskResult=wiki 196857、getBalance=wiki 229767
 */
import { httpJson } from '../../../infrastructure/http'
import { CaptchaFailure } from '../provider'

/** 平台响应包（官方字段：errorId 0=无错误 1=有错误；status processing/ready；solution 随任务类型不同） */
export interface YesCaptchaResp {
  errorId?: number
  errorCode?: string
  errorDescription?: string
  taskId?: string
  status?: string
  solution?: { token?: string; gRecaptchaResponse?: string; text?: string; objects?: number[]; hasObject?: boolean; type?: string }
  balance?: number
}

export interface YesCaptchaApiCfg {
  apiBase: string
  clientKey: string
}

export class YesCaptchaApiClient {
  constructor(private cfg: YesCaptchaApiCfg) {}

  /** 平台接口统一调用（官方未限定 createTask/getBalance 耗时；30s 固定超时覆盖慢响应） */
  private async call(path: string, body: unknown): Promise<YesCaptchaResp> {
    return httpJson<YesCaptchaResp>({ baseUrl: this.cfg.apiBase, path, method: 'POST', body, timeoutMs: 30000 })
  }

  /** 创建识别任务（官方 33351：body={clientKey, task}；返回 taskId 供 getTaskResult 轮询） */
  async createTask(task: Record<string, unknown>): Promise<string> {
    const resp = await this.call('/createTask', { clientKey: this.cfg.clientKey, task })
    if (resp.errorId != null && resp.errorId !== 0) throw new CaptchaFailure(`yescaptcha 创建任务失败: ${resp.errorCode ?? resp.errorId}`)
    if (!resp.taskId) throw new CaptchaFailure('yescaptcha 创建任务失败: 未返回 taskId')
    return resp.taskId
  }

  /** 查询任务结果（官方 196857：body={clientKey, taskId}；errorId!=0 快速失败；status 非 ready 由调用方继续轮询） */
  async getTaskResult(taskId: string): Promise<YesCaptchaResp> {
    const resp = await this.call('/getTaskResult', { clientKey: this.cfg.clientKey, taskId })
    if (resp.errorId != null && resp.errorId !== 0) throw new CaptchaFailure(`yescaptcha 查询结果失败: ${resp.errorCode ?? resp.errorId}`)
    return resp
  }

  /** 查询账户余额（官方 229767：body={clientKey}；balance 为点数 Decimal） */
  async getBalance(): Promise<number> {
    const resp = await this.call('/getBalance', { clientKey: this.cfg.clientKey })
    if (resp.errorId != null && resp.errorId !== 0) throw new CaptchaFailure(`yescaptcha 查询余额失败: ${resp.errorCode ?? resp.errorId}`)
    return resp.balance ?? 0
  }
}
