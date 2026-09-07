/**
 * 账号表读写（tools 层）：以 exceljs 直接读写 accounts.xlsx
 * 依赖方向：仅依赖 exceljs；读写约定与 infrastructure/datasource 一致（第一行表头、跳过完全空白行）
 */
import ExcelJS from 'exceljs'

/** 账号表元数据（tools 用）：列清单 + 非空数据行（行号 1 起） */
export interface XlsxMeta {
  columns: string[]
  rows: Array<{ rowNumber: number; window: string }>
}

/** 读取表头与数据行；窗口标识取「窗口名称」列，其次「窗口」列，兜底行号 */
export async function readXlsxMeta(path: string): Promise<XlsxMeta> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(path)
  const sheet = wb.worksheets[0]
  if (!sheet) throw new Error('Excel 中没有工作表')
  const headerRow = sheet.getRow(1)
  const columns: string[] = []
  for (let i = 1; i <= headerRow.cellCount; i++) columns.push(String(headerRow.getCell(i).text ?? '').trim())
  while (columns.length > 0 && columns[columns.length - 1] === '') columns.pop()
  const winNameIdx = columns.indexOf('窗口名称') + 1
  const winIdx = columns.indexOf('窗口') + 1
  const rows: XlsxMeta['rows'] = []
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return
    const text = (i: number) => String(row.getCell(i).text ?? '').trim()
    const hasValue = columns.some((_, i) => text(i + 1) !== '')
    if (!hasValue) return
    const window = (winNameIdx > 0 && text(winNameIdx)) || (winIdx > 0 && text(winIdx)) || `第${rowNumber}行`
    rows.push({ rowNumber, window })
  })
  return { columns, rows }
}

/** 把 updates 写入目标列对应行（其他单元格不动），写回原文件；列不存在抛错 */
export async function writeCells(
  path: string,
  column: string,
  updates: Array<{ rowNumber: number; value: string }>,
): Promise<void> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(path)
  const sheet = wb.worksheets[0]
  if (!sheet) throw new Error('Excel 中没有工作表')
  const headerRow = sheet.getRow(1)
  let colIdx = -1
  for (let i = 1; i <= headerRow.cellCount; i++) {
    if (String(headerRow.getCell(i).text ?? '').trim() === column) {
      colIdx = i
      break
    }
  }
  if (colIdx < 0) throw new Error(`找不到列: ${column}`)
  for (const u of updates) sheet.getRow(u.rowNumber).getCell(colIdx).value = u.value
  await wb.xlsx.writeFile(path)
}
