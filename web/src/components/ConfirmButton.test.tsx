import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { App } from 'antd'
import type { ReactElement } from 'react'
import ConfirmButton from './ConfirmButton'

function renderInApp(ui: ReactElement) {
  return render(<App>{ui}</App>)
}

describe('ConfirmButton', () => {
  it('popconfirm：点确认才执行，取消不执行', async () => {
    const onConfirm = vi.fn()
    renderInApp(
      <ConfirmButton confirm={{ title: '确认删除？', okText: 'OK', cancelText: 'Cancel' }} onConfirm={onConfirm}>删除</ConfirmButton>,
    )
    fireEvent.click(screen.getByRole('button', { name: /删\s?除/ }))
    await screen.findByText('确认删除？')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onConfirm).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /删\s?除/ }))
    await screen.findByText('确认删除？')
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1))
  })

  it('modal：确认后执行', async () => {
    const onConfirm = vi.fn()
    renderInApp(
      <ConfirmButton confirm={{ title: '确认停止？', mode: 'modal', okText: 'OK', cancelText: 'Cancel' }} onConfirm={onConfirm}>停止</ConfirmButton>,
    )
    fireEvent.click(screen.getByRole('button', { name: /停\s?止/ }))
    // modal.confirm 会把 title 同时渲染到弹窗标题与确认体，findByText 会命中多个；改等 dialog 出现
    await screen.findByRole('dialog')
    fireEvent.click(await screen.findByRole('button', { name: 'OK' }))
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1))
  })

  it('执行中按钮禁用（busy），onConfirm 未结束不重复执行', async () => {
    let resolve: () => void = () => {}
    const onConfirm = vi.fn(() => new Promise<void>((r) => { resolve = r }))
    renderInApp(
      <ConfirmButton confirm={{ title: '确认？', okText: 'OK', cancelText: 'Cancel' }} onConfirm={onConfirm}>go</ConfirmButton>,
    )
    fireEvent.click(screen.getByRole('button', { name: /go/ }))
    await screen.findByText('确认？')
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    // onConfirm 仍挂起（busy）：触发按钮必须禁用，去掉该防护此断言即失败
    // busy 期间按钮进入 loading，访问名变为 "loading go"，用部分匹配仍指向同一按钮
    await waitFor(() => expect(screen.getByRole('button', { name: /go/ })).toBeDisabled())
    expect(onConfirm).toHaveBeenCalledTimes(1)
    await act(async () => {
      resolve()
    })
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })
})
