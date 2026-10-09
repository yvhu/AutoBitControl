import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 文档漂移守卫：TaskContext 公开门面成员必须出现在用户手册 docs/API-GUIDE.md 中。
 *
 * 为什么用显式白名单：TaskContext 原型上还挂着 private turnstileLogger 等私有实现
 * （JS 无真私有，getOwnPropertyNames 会一并取到），用白名单只校验「对外承诺」的公开面，
 * 避免把私有项误当文档缺口。公开面以 src/engine/task-context.ts 为准。
 */

/** TaskContext 顶层公开门面（getter + 方法） */
const FACADE_MEMBERS = [
  'page',
  'log',
  'profile',
  'accountRow',
  'account',
  'uploadFile',
  'screenshot',
  'safeScreenshot',
  'js',
  'wallet',
  'captcha',
  'race',
  'recover',
  'step',
  'steps',
] as const

/** ctx.wallet 命名空间公开方法 */
const WALLET_MEMBERS = ['ready', 'login', 'sign', 'confirmTx', 'ensureLoggedIn'] as const

/** ctx.captcha 命名空间公开方法 */
const CAPTCHA_MEMBERS = ['turnstile', 'visible', 'autoClick'] as const

describe('文档漂移守卫', () => {
  const guide = readFileSync(join(process.cwd(), 'docs', 'API-GUIDE.md'), 'utf8')

  it('TaskContext 公开门面成员都在 API-GUIDE 中出现', () => {
    const missing = FACADE_MEMBERS.filter((m) => !guide.includes(m))
    expect(missing, `手册缺少门面成员: ${missing.join(', ')}`).toEqual([])
  })

  it('ctx.wallet 命名空间方法都在 API-GUIDE 中出现', () => {
    const missing = WALLET_MEMBERS.filter((m) => !guide.includes(m))
    expect(missing, `手册缺少 wallet 方法: ${missing.join(', ')}`).toEqual([])
  })

  it('ctx.captcha 命名空间方法都在 API-GUIDE 中出现', () => {
    const missing = CAPTCHA_MEMBERS.filter((m) => !guide.includes(m))
    expect(missing, `手册缺少 captcha 方法: ${missing.join(', ')}`).toEqual([])
  })
})
