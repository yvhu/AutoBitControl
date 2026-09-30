/**
 * 系统任务批量导入弹窗：逐行勾选 + 指定状态列/优先级；已绑定任务置灰
 * 依赖方向：依赖 ./hooks、./board 与 ../../types，被 index.tsx 挂载
 */
import { useEffect, useMemo, useState } from 'react'
import { Checkbox, Empty, Modal, Select, Spin, Tag, Typography } from 'antd'
import { PRIORITY_LABEL } from './board'
import { useAirdropProjects, useImportProjects, useTasks } from './hooks'
import type { AirdropImportItem, AirdropPriority, AirdropStatusItem, TaskMetaView } from '../../types'

interface RowState { checked: boolean; statusId: number | undefined; priority: AirdropPriority }

/** 从系统任务批量导入弹窗：逐行勾选 + 指定状态列/优先级；已绑定任务置灰 */
export default function ImportModal({ open, onClose, statuses }: { open: boolean; onClose: () => void; statuses: AirdropStatusItem[] }) {
  const tasks = useTasks()
  const projects = useAirdropProjects()
  const importProjects = useImportProjects()
  const [rows, setRows] = useState<Record<string, RowState>>({})

  const boundMap = useMemo(() => {
    const map = new Map<string, string>()
    for (const p of projects.data ?? []) if (p.taskKey) map.set(p.taskKey, p.name)
    return map
  }, [projects.data])

  useEffect(() => {
    if (!open) return
    const init: Record<string, RowState> = {}
    for (const t of tasks.data ?? []) init[t.key] = { checked: false, statusId: statuses[0]?.id, priority: 'mid' }
    setRows(init)
  }, [open, tasks.data, statuses])

  const onOk = () => {
    const items: AirdropImportItem[] = []
    for (const t of tasks.data ?? []) {
      const r = rows[t.key]
      if (r?.checked && r.statusId !== undefined) items.push({ taskKey: t.key, statusId: r.statusId, priority: r.priority })
    }
    if (items.length === 0) return
    importProjects.mutate({ items }, { onSuccess: onClose })
  }

  return (
    <Modal open={open} title="从系统任务导入" onCancel={onClose} onOk={onOk} confirmLoading={importProjects.isPending} okText="导入" cancelText="取消" width={640}>
      {tasks.isPending ? (
        <div style={{ textAlign: 'center', padding: 32 }}><Spin /></div>
      ) : (tasks.data ?? []).length === 0 ? (
        <Empty description="暂无系统任务" />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {tasks.data!.map((t: TaskMetaView) => {
            const bound = boundMap.get(t.key)
            const r = rows[t.key]
            return (
              <div key={t.key} style={{ display: 'flex', alignItems: 'center', gap: 10, opacity: bound ? 0.45 : 1 }}>
                <Checkbox
                  checked={r?.checked ?? false}
                  disabled={Boolean(bound)}
                  onChange={(e) => setRows((prev) => ({ ...prev, [t.key]: { ...prev[t.key], checked: e.target.checked } }))}
                />
                <Typography.Text style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</Typography.Text>
                {bound ? (
                  <Tag>已导入：{bound}</Tag>
                ) : (
                  <>
                    <Select
                      size="small"
                      value={r?.statusId}
                      options={statuses.map((s) => ({ value: s.id, label: s.name }))}
                      onChange={(v) => setRows((prev) => ({ ...prev, [t.key]: { ...prev[t.key], statusId: v } }))}
                      style={{ width: 120 }}
                    />
                    <Select
                      size="small"
                      value={r?.priority}
                      options={(['high', 'mid', 'low'] as const).map((v) => ({ value: v, label: PRIORITY_LABEL[v] }))}
                      onChange={(v) => setRows((prev) => ({ ...prev, [t.key]: { ...prev[t.key], priority: v } }))}
                      style={{ width: 80 }}
                    />
                  </>
                )}
              </div>
            )
          })}
        </div>
      )}
    </Modal>
  )
}
