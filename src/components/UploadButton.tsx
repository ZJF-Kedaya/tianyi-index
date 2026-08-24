/**
 * 网页端文件上传按钮（管理员可见）。
 *
 * OneDrive：Graph createUploadSession，前端分片 PUT 直传微软服务器。
 * 天翼云盘：服务端加密接口会话 + 客户端计算 MD5，字节流切成 ~4MB 片段
 * 经 Vercel 中继转发（天翼 CDN 不支持浏览器跨域直传），服务端攒齐整片后 PUT CDN。
 */

import { useRef, useState } from 'react'

import CryptoJS from 'crypto-js'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faCloudArrowUp, faCheck, faXmark } from '@fortawesome/free-solid-svg-icons'
import { mutate as globalMutate } from 'swr'

import { useIsAdmin } from '../utils/useIsAdmin'

// Graph 要求非末片必须是 320KiB 的整数倍且 >= 5MiB
const OD_CHUNK_SIZE = 8 * 1024 * 1024
// 天翼协议分片固定 10MB，中继片段取 4MB（Vercel 请求体硬顶 ~4.5MB）
const TY_PART_SIZE = 10 * 1024 * 1024
const TY_FRAGMENT_SIZE = 4 * 1024 * 1024

interface UploadTask {
  id: number
  name: string
  size: number
  uploaded: number
  status: 'hashing' | 'uploading' | 'done' | 'error'
  message?: string
}

/** Uint8Array → CryptoJS WordArray（逐字节组字，避免直接传 TypedArray 出错） */
function u8ToWordArray(u8: Uint8Array): ReturnType<typeof CryptoJS.lib.WordArray.create> {
  const words: number[] = []
  for (let i = 0; i < u8.length; i++) {
    words[i >>> 2] = (words[i >>> 2] || 0) | (u8[i] << (24 - (i % 4) * 8))
  }
  return CryptoJS.lib.WordArray.create(words, u8.length)
}

async function postJson(body: Record<string, unknown>): Promise<any> {
  const res = await fetch('/api/od/upload/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`)
  return data
}

export default function UploadButton({ dirPath, drive }: { dirPath: string; drive: 'ty' | 'od' | 'p123' }) {
  const isAdmin = useIsAdmin()
  const inputRef = useRef<HTMLInputElement>(null)
  const [tasks, setTasks] = useState<UploadTask[]>([])
  const [panelOpen, setPanelOpen] = useState(false)
  const supported = drive === 'od' || drive === 'ty'

  if (!isAdmin || !supported) return null

  function updateTask(id: number, patch: Partial<UploadTask>) {
    setTasks(current => current.map(t => (t.id === id ? { ...t, ...patch } : t)))
  }

  // ---------- OneDrive：Graph 会话直传 ----------
  async function uploadOd(id: number, file: File) {
    const created = await postJson({ action: 'create-session', path: dirPath, fileName: file.name, size: file.size })
    const uploadUrl: string = created?.data?.uploadUrl
    if (!uploadUrl) throw new Error('创建上传会话失败')

    let offset = 0
    while (offset < file.size) {
      const end = Math.min(offset + OD_CHUNK_SIZE, file.size)
      const putRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Range': `bytes ${offset}-${end - 1}/${file.size}` },
        body: file.slice(offset, end),
      })
      if (!putRes.ok) throw new Error(`分片上传失败 HTTP ${putRes.status}`)
      offset = end
      updateTask(id, { uploaded: offset })
      if (offset < file.size) {
        const respData = await putRes.json().catch(() => null)
        const expected: string[] | undefined = respData?.nextExpectedRanges
        if (expected && expected.length > 0) {
          const serverNext = parseInt(expected[0].split('-')[0], 10)
          if (Number.isFinite(serverNext) && serverNext !== offset) offset = serverNext
        }
      }
    }
  }

  // ---------- 天翼：客户端算 MD5 + 服务端中继 ----------
  async function uploadTy(id: number, file: File) {
    // 1. 渐进计算全文件 MD5 与每个 10MB 协议分片的 MD5
    updateTask(id, { status: 'hashing' })
    const fileHasher = CryptoJS.algo.MD5.create()
    const partMd5Hexs: string[] = []
    const partMd5Base64s: string[] = []
    for (let offset = 0; offset < file.size; offset += TY_PART_SIZE) {
      const end = Math.min(offset + TY_PART_SIZE, file.size)
      const partHasher = CryptoJS.algo.MD5.create()
      for (let pos = offset; pos < end; pos += 1024 * 1024) {
        const buf = new Uint8Array(await file.slice(pos, Math.min(pos + 1024 * 1024, end)).arrayBuffer())
        const wa = u8ToWordArray(buf)
        fileHasher.update(wa)
        partHasher.update(wa)
        updateTask(id, { uploaded: Math.min(pos + 1024 * 1024, end) })
      }
      const partFinal = partHasher.finalize()
      partMd5Hexs.push(partFinal.toString(CryptoJS.enc.Hex).toUpperCase())
      partMd5Base64s.push(partFinal.toString(CryptoJS.enc.Base64))
    }
    const fileMd5 = fileHasher.finalize().toString(CryptoJS.enc.Hex).toUpperCase()
    const sliceMd5 = file.size <= TY_PART_SIZE ? fileMd5 : CryptoJS.MD5(partMd5Hexs.join('\n')).toString(CryptoJS.enc.Hex).toUpperCase()

    // 2. 创建会话（可能命中秒传）
    const created = await postJson({
      action: 'create-session',
      path: dirPath,
      fileName: file.name,
      size: file.size,
      fileMd5,
      sliceMd5,
    })
    if (created?.data?.rapidUpload) {
      updateTask(id, { uploaded: file.size })
      return
    }
    const uploadFileId: string = created?.data?.uploadFileId
    if (!uploadFileId) throw new Error('创建上传会话失败')

    // 3. 逐分片中继（每片拆成多个 4MB 片段）
    updateTask(id, { status: 'uploading', uploaded: 0 })
    const totalParts = partMd5Base64s.length
    for (let p = 0; p < totalParts; p++) {
      const partStart = p * TY_PART_SIZE
      const partEnd = Math.min(partStart + TY_PART_SIZE, file.size)
      const fragTotal = Math.ceil((partEnd - partStart) / TY_FRAGMENT_SIZE)
      for (let f = 0; f < fragTotal; f++) {
        const fragStart = partStart + f * TY_FRAGMENT_SIZE
        const fragEnd = Math.min(fragStart + TY_FRAGMENT_SIZE, partEnd)
        const res = await fetch(
          `/api/ty/upload/?uploadFileId=${encodeURIComponent(uploadFileId)}&partNumber=${p + 1}&partMd5Base64=${encodeURIComponent(partMd5Base64s[p])}&fragIndex=${f}&fragTotal=${fragTotal}`,
          { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: await file.slice(fragStart, fragEnd).arrayBuffer() },
        )
        if (!res.ok) {
          const err = await res.json().catch(() => ({}))
          throw new Error(err?.error || `中继分片失败 HTTP ${res.status}`)
        }
        updateTask(id, { uploaded: fragEnd })
      }
    }

    // 4. 提交
    const commitRes = await fetch('/api/ty/upload/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'commit', uploadFileId, fileMd5, sliceMd5 }),
    })
    if (!commitRes.ok) {
      const err = await commitRes.json().catch(() => ({}))
      throw new Error(err?.error || '提交上传失败')
    }
  }

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return
    const newTasks: UploadTask[] = Array.from(files).map((f, i) => ({
      id: Date.now() + i,
      name: f.name,
      size: f.size,
      uploaded: 0,
      status: 'hashing',
    }))
    setTasks(current => [...newTasks, ...current])
    setPanelOpen(true)

    for (let i = 0; i < newTasks.length; i++) {
      try {
        updateTask(newTasks[i].id, { status: drive === 'ty' ? 'hashing' : 'uploading' })
        if (drive === 'od') {
          await uploadOd(newTasks[i].id, files[i])
        } else {
          await uploadTy(newTasks[i].id, files[i])
        }
        updateTask(newTasks[i].id, { status: 'done', uploaded: newTasks[i].size })
        globalMutate(() => true, undefined, { revalidate: true })
      } catch (e: any) {
        updateTask(newTasks[i].id, { status: 'error', message: e?.message || '上传失败' })
      }
    }
    if (inputRef.current) inputRef.current.value = ''
  }

  return (
    <>
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        className="inline-flex min-h-[36px] items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-950 dark:text-zinc-300 dark:hover:bg-zinc-700 dark:hover:text-white"
        title="上传到当前目录"
      >
        <FontAwesomeIcon icon={faCloudArrowUp} />
        <span>上传</span>
      </button>
      <input ref={inputRef} type="file" multiple hidden onChange={e => handleFiles(e.target.files)} />

      {panelOpen && tasks.length > 0 && (
        <div className="fixed bottom-4 right-4 z-50 w-80 rounded-xl border border-slate-200 bg-white p-3 shadow-lg dark:border-zinc-700 dark:bg-zinc-800">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-xs font-semibold text-slate-700 dark:text-zinc-200">上传任务</p>
            <button type="button" onClick={() => setPanelOpen(false)} className="text-slate-400 hover:text-slate-600">
              <FontAwesomeIcon icon={faXmark} />
            </button>
          </div>
          <div className="max-h-60 space-y-2 overflow-y-auto">
            {tasks.map(task => {
              const percent = task.size > 0 ? Math.min(100, Math.round((task.uploaded / task.size) * 100)) : 100
              return (
                <div key={task.id}>
                  <div className="flex items-center justify-between gap-2 text-[11px]">
                    <span className="truncate font-medium text-slate-700 dark:text-zinc-200">{task.name}</span>
                    {task.status === 'done' ? (
                      <FontAwesomeIcon icon={faCheck} className="shrink-0 text-emerald-500" />
                    ) : task.status === 'error' ? (
                      <FontAwesomeIcon icon={faXmark} className="shrink-0 text-red-500" />
                    ) : (
                      <span className="shrink-0 tabular-nums text-slate-400">
                        {task.status === 'hashing' ? '校验中' : `${percent}%`}
                      </span>
                    )}
                  </div>
                  <div className="mt-1 h-1 overflow-hidden rounded bg-slate-100 dark:bg-zinc-700">
                    <div
                      className={`h-full rounded transition-all ${task.status === 'error' ? 'bg-red-500' : task.status === 'done' ? 'bg-emerald-500' : task.status === 'hashing' ? 'bg-amber-400' : 'bg-blue-500'}`}
                      style={{ width: `${task.status === 'error' ? 100 : percent}%` }}
                    />
                  </div>
                  {task.status === 'error' && <p className="mt-1 text-[10px] leading-3 text-red-500">{task.message}</p>}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </>
  )
}
