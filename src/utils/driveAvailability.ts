/**
 * 网盘可用性探测：判断各网盘是否已配置凭据。
 *
 * 「已配置」= 对应账号/凭据存在（运行时配置或环境变量）。
 * 前端据此决定是否在根目录展示对应网盘入口；未配置的网盘不再显示。
 */

import { getRuntimeConfigValue } from './runtimeConfigStore'

export interface DrivesAvailability {
  tianyi: boolean
  onedrive: boolean
  pan123: boolean
}

/** 逐网盘检查凭据是否齐全 */
export async function getDrivesAvailability(): Promise<DrivesAvailability> {
  const [tyUser, tyPass, odId, odSecret, p123User, p123Pass] = await Promise.all([
    getRuntimeConfigValue('TIANYI_USERNAME'),
    getRuntimeConfigValue('TIANYI_PASSWORD'),
    getRuntimeConfigValue('CLIENT_ID'),
    getRuntimeConfigValue('CLIENT_SECRET'),
    getRuntimeConfigValue('P123_USERNAME'),
    getRuntimeConfigValue('P123_PASSWORD'),
  ])
  return {
    tianyi: Boolean(tyUser && tyPass),
    onedrive: Boolean(odId && odSecret),
    pan123: Boolean(p123User && p123Pass),
  }
}
