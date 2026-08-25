/**
 * WebDAV 虚拟根目录下的云盘注册表。
 *
 * 新增网盘挂载时：
 * 1. 在此注册 { name, id }（name 是 WebDAV 虚拟根下的目录名）；
 * 2. 在 src/pages/api/dav/[[...path]].ts 的 handlePropfind / handleGet 中
 *    实现对应 drive id 的目录列举与文件下载逻辑。
 * 其余（根目录入口展示、路径解析）自动生效。
 */
import { ADMIN_TY_FOLDER_NAME, ADMIN_P123_FOLDER_NAME } from './driveResolver'

export const DAV_DRIVES = [
  { name: '天翼云盘', id: 'ty' },
  { name: 'OneDrive', id: 'od' },
  { name: '123云盘', id: 'p123' },
] as const

export type DavDriveId = (typeof DAV_DRIVES)[number]['id'] | 'root'

export function getDavDriveByName(name: string): (typeof DAV_DRIVES)[number] | undefined {
  return DAV_DRIVES.find(d => d.name === name)
}
/**
 * 按网盘配置状态过滤根目录资源列表：
 * 未配置凭据的网盘不出现在 WebDAV 根目录（视为不存在）。
 */
export function filterRootDrivesByAvailability<T extends { displayName?: string }>(
  resources: T[],
  avail: { tianyi: boolean; onedrive: boolean; pan123: boolean },
): T[] {
  return resources.filter(r => {
    if (r.displayName === 'OneDrive') return avail.onedrive
    if (r.displayName === ADMIN_P123_FOLDER_NAME) return avail.pan123
    if (r.displayName === ADMIN_TY_FOLDER_NAME) return avail.tianyi
    return true
  })
}
