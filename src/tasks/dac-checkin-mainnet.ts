/**
 * DAC 主网签到任务（dac-checkin-mainnet）：正式环境（主网）签到
 * 站点：待真机核实（url 暂为占位，TODO）
 * 与 inception-dachain（原测试网量子箱开箱）区分：本任务为正式环境签到流程
 * 执行流程（待实现）：打开任务页 → 声明式钱包登录 → 判已签到（幂等）→ 签到 → 断言成功标志
 * 依赖方向：依赖 ./base（任务基类）与 ../api（能力函数）
 * 状态：占位骨架——meta 与文件已建，run 逻辑与选择器待补全
 */
import { SiteTask, type TaskContext, type TaskMeta } from './base'

/** 占位落地页：真机核实后替换为 DAC 主网签到页真实 URL */
const PLACEHOLDER_URL = 'https://example.com/'

export class DacCheckinMainnetTask extends SiteTask {
  meta: TaskMeta = {
    key: 'dac-checkin-mainnet', // 全局唯一任务键（面板/API/数据库均以此索引）
    name: 'DAC 签到（主网）', // 与测试网任务 inception-dachain 区分
    group: { key: 'dac-mainnet', name: 'DAC 主网' },
    url: PLACEHOLDER_URL, // TODO: 替换为 DAC 主网签到页真实 URL
    sourceUrl: '', // TODO: 填入来源说明链接
    note: '占位骨架：正式环境（主网）签到任务，run 逻辑/选择器待真机核实后补全；与测试网任务 inception-dachain 区分',
    category: 'checkin',
    lastUpdated: '2026-10-15',
    enabled: false, // 占位：实现并真机验证后再开启
    wallet: 'metamask',
    timeoutSec: 600,
    retry: { max: 2, backoffSec: 600 },
    concurrency: 4,
  }

  /**
   * 执行流程（待实现）：打开任务页 → 声明式钱包登录 → 判已签到（幂等）→ 点签到 → 断言成功标志。
   * 参考实现：src/tasks/konnex-checkin.ts（签到类）、src/tasks/example-checkin.ts（标准骨架）。
   * @param ctx 任务上下文
   */
  async run(ctx: TaskContext): Promise<void> {
    void ctx
    // TODO: 按 docs/API-GUIDE.md 补全 DAC 主网签到流程（登录标志/签到按钮/成功判定/幂等态）
    throw new Error('dac-checkin-mainnet 尚未实现（占位骨架）：请补全主网签到流程后再启用')
  }
}
