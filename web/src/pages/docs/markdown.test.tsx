/**
 * MarkdownView 标题锚点单测：####/#####/###### 必须渲染为语义标题并带 slugify id，
 * 否则搜索命中项 scrollToHeading 会跳到 null（手册 API 参考的 22 个函数标题均为 ####）。
 * 依赖方向：仅依赖 antd 默认主题与测试 setup 提供的 matchMedia。
 */
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import MarkdownView from './markdown'

describe('MarkdownView 深层标题', () => {
  it('####/#####/###### 渲染为带 id 与类的语义标题', () => {
    const { container } = render(
      <MarkdownView content={'#### wallet.ensureLoggedIn\n\n##### 五级标题\n\n###### 六级标题'} />,
    )
    const h4 = container.querySelector('h4.doc-h4')
    const h5 = container.querySelector('h5.doc-h5')
    const h6 = container.querySelector('h6.doc-h6')
    expect(h4?.getAttribute('id')).toBe('walletensureloggedin')
    expect(h5?.getAttribute('id')).toBe('五级标题')
    expect(h6?.getAttribute('id')).toBe('六级标题')
  })
})
