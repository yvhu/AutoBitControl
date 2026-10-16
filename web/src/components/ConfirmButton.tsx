/**
 * ConfirmButton（web 公共）：带二次确认 + 防重复的按钮
 * - popconfirm 模式：行内小按钮；modal 模式：工具栏/下拉/卡片级
 * - onConfirm 执行期间按钮与确认 OK 均 loading 且禁用；完成后 cooldownMs 内禁用（吞连点）
 * 依赖方向：依赖 antd 与 react
 */
import { useState, type ReactNode } from 'react'
import { App, Button, Popconfirm, type ButtonProps } from 'antd'

const COOLDOWN_MS = 600

export interface ConfirmConfig {
  title: ReactNode
  description?: ReactNode
  okText?: string
  cancelText?: string
  mode?: 'popconfirm' | 'modal'
}

export interface ConfirmButtonProps extends Omit<ButtonProps, 'onClick'> {
  confirm: ConfirmConfig
  onConfirm: () => void | Promise<void>
}

export default function ConfirmButton({ confirm, onConfirm, loading, disabled, ...buttonProps }: ConfirmButtonProps) {
  const { modal } = App.useApp()
  const [busy, setBusy] = useState(false)
  const [cooling, setCooling] = useState(false)

  const run = async () => {
    setBusy(true)
    try {
      await onConfirm()
    } finally {
      setBusy(false)
      setCooling(true)
      setTimeout(() => setCooling(false), COOLDOWN_MS)
    }
  }

  const blocked = !!disabled || busy || cooling
  const btn = <Button {...buttonProps} loading={loading || busy} disabled={blocked} />

  if (confirm.mode === 'modal') {
    return (
      <Button
        {...buttonProps}
        loading={loading || busy}
        disabled={blocked}
        onClick={() => {
          if (blocked) return
          modal.confirm({
            title: confirm.title,
            content: confirm.description,
            okText: confirm.okText ?? '确认',
            cancelText: confirm.cancelText ?? '取消',
            okButtonProps: { danger: buttonProps.danger },
            onOk: run,
          })
        }}
      />
    )
  }
  return (
    <Popconfirm
      title={confirm.title}
      description={confirm.description}
      okText={confirm.okText ?? '确认'}
      cancelText={confirm.cancelText ?? '取消'}
      okButtonProps={{ danger: buttonProps.danger, loading: busy }}
      disabled={blocked}
      onConfirm={run}
    >
      {btn}
    </Popconfirm>
  )
}
