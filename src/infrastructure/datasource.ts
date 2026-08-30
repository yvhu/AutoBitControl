/**
 * 数据源（infrastructure 层）：从 Excel 表格加载"每窗口一份"的账号/素材数据
 * 依赖方向：仅依赖 exceljs，被 app 顶层装配，被 engine 层以类型引用
 * 设计思路：第一行是表头，每行对应一个窗口的数据（邮箱/钱包/邀请码/图片等任意列），
 * 任务侧通过 ctx.account('列名') 取本窗口的值，取代"每个窗口随机现编"的 faker 方案。
 * 映射模式两种（按是否存在"窗口"列自动判定）：
 *   A. 有"窗口"列 → 按 窗口名/比特ID 精确匹配行
 *   B. 无"窗口"列 → 按窗口列表顺序取第 i 行（list 顺序 = 面板顺序）
 */
import ExcelJS from 'exceljs'

/** 数据源中的一行 */
export interface DataSourceRow {
  /** 显式映射列的值（"窗口"列），可能为空 */
  window: string
  /** 该行全部单元格：列名 -> 字符串值（去首尾空格，空串保留） */
  values: Record<string, string>
}

export class DataSource {
  /** 加载成功与否；未配置/文件不存在/解析失败时 available=false 并记录原因（warn 用） */
  available = false
  error = ''
  rows: DataSourceRow[] = []
  columns: string[] = []
  /** 是否存在"窗口"列（决定映射模式 A/B） */
  hasWindowColumn = false

  /**
   * 从 xlsx 加载：第一行=表头；跳过完全空白的行；列名去首尾空格
   * 解析失败把错误存 error 字段、available=false、不抛出（数据源是可选增强，不阻断启动）
   */
  async load(path: string): Promise<void> {
    this.available = false
    this.error = ''
    this.rows = []
    this.columns = []
    this.hasWindowColumn = false
    try {
      const workbook = new ExcelJS.Workbook()
      await workbook.xlsx.readFile(path)
      // 只取第一个工作表（数据源约定单表）
      const sheet = workbook.worksheets[0]
      if (!sheet) {
        this.error = 'Excel 中没有工作表'
        return
      }
      // 第一行 = 表头（列名去首尾空格；空白单元格按空串处理，保持列位对齐）
      const headerRow = sheet.getRow(1)
      const rawColumns: string[] = []
      for (let i = 1; i <= headerRow.cellCount; i++) {
        rawColumns.push(String(headerRow.getCell(i).text ?? '').trim())
      }
      // 去掉尾部连续的空列（Excel 常出现整列无数据但有格式残留）
      while (rawColumns.length > 0 && rawColumns[rawColumns.length - 1] === '') rawColumns.pop()
      this.columns = rawColumns
      if (this.columns.length === 0) {
        this.error = '表头为空'
        return
      }
      this.hasWindowColumn = this.columns.includes('窗口')
      // 从第二行开始逐行解析：完全空白的行跳过（模板常有多余的空行）
      sheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return
        const values: Record<string, string> = {}
        let hasValue = false
        this.columns.forEach((col, i) => {
          const raw = row.getCell(i + 1).text ?? ''
          const v = String(raw).trim()
          values[col] = v
          if (v !== '') hasValue = true
        })
        if (!hasValue) return
        this.rows.push({ window: values['窗口'] ?? '', values })
      })
      this.available = true
    } catch (e) {
      // 文件不存在/损坏/格式非法：记录原因，静默降级（任务侧 faker 兜底）
      this.error = (e as Error).message
    }
  }

  /**
   * A/B 混合映射：有窗口列 → 按 窗口名/比特ID 精确匹配；无 → 按窗口列表顺序（list 顺序=面板顺序）取第 i 行
   * @param profile 当前窗口记录
   * @param orderedProfiles 全量窗口列表（与面板同序），模式 B 下用 indexOf 定位行号
   * @returns 命中的行；未命中返回 null
   */
  rowFor(profile: { id: number; bitbrowserId: string; name: string }, orderedProfiles: { bitbrowserId: string }[]): DataSourceRow | null {
    if (!this.available || this.rows.length === 0) return null
    if (this.hasWindowColumn) {
      // 模式 A：窗口列的值精确匹配窗口名或比特窗口 ID（两者写哪个都认）
      return this.rows.find(r => r.window !== '' && (r.window === profile.name || r.window === profile.bitbrowserId)) ?? null
    }
    // 模式 B：按窗口列表顺序取第 i 行（无窗口列时顺序即契约，文档写明）
    const i = orderedProfiles.findIndex(p => p.bitbrowserId === profile.bitbrowserId)
    if (i < 0 || i >= this.rows.length) return null
    return this.rows[i]
  }

  /** 摘要信息（面板展示用） */
  summary(): { rows: number; columns: string[] } {
    return { rows: this.rows.length, columns: this.columns }
  }
}
