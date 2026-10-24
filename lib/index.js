/**
 * dsh-bili-img —— 让 agent 能在 B站 发图（私信 / 评论区）
 *
 * 只做一件事：注册一个 tool `bili_send_image`，真正干活的是 tools/bili-img.mjs。
 * 凭据永远不经过插件：脚本自己读 ~/.bili-ai/credentials.json（bili-whale 写的那份）。
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

// @deepseek-ai/dsh-tools 由宿主（Harness 自己的 dsh/node_modules）提供；解析不到时退回
// 恒等包装，保证插件不会因为一个 peer 依赖没被宿主暴露就直接崩掉整个 profile。
let defineTool = (spec) => spec
try {
  const mod = await import('@deepseek-ai/dsh-tools')
  if (typeof mod.defineTool === 'function') defineTool = mod.defineTool
} catch (e) {
  // 宿主没暴露这个包：工具仍按普通对象注册，宿主能认就认，认不了也不牵连启动
}

export const name = 'dsh-bili-img'
export const inject = ['tools']

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = path.join(HERE, '..', 'tools', 'bili-img.mjs')

/** 找真 node：Electron 的 process.execPath 是 Harness.exe，跑不了脚本 */
function findNode() {
  const cands = [
    process.env.DSH_NODE,
    process.env.BILI_NODE,
    path.join(os.homedir(), '.dsh', 'node.exe'),
    'E:/java/node.exe',
    'C:/Program Files/nodejs/node.exe',
  ].filter(Boolean)
  for (const c of cands) {
    try { if (fs.existsSync(c)) return c } catch (e) {}
  }
  return 'node' // 交给 PATH；找不到会以 ENOENT 报出来
}

function runCli(args) {
  return new Promise((resolve) => {
    execFile(findNode(), [SCRIPT, ...args], { timeout: 120000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = String(stdout || '').trim()
      const errText = String(stderr || '').trim()
      if (err) {
        resolve({ ok: false, code: err.code ?? -1, stdout: out, stderr: errText || String(err.message || err) })
        return
      }
      resolve({ ok: true, code: 0, stdout: out, stderr: errText })
    })
  })
}

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'bili_send_image',
    description: '在 B站 发图：私信发图（action=dm）、评论区发图（action=comment）、删自己发的评论（action=del）、只上传图床（action=upload）。图片可以先用 crop 参数裁掉截图边框（left,top,right,bottom 像素）。默认 dry-run，只回显将要做什么；真正发送必须显式 go=true。私信不写 to 就默认发给主人。',
    parameters: {
      action: { type: 'string', required: true, enum: ['dm', 'comment', 'del', 'upload'], description: '要做什么。' },
      file: { type: 'string', description: '图片绝对路径（dm/comment/upload 必填）。' },
      to: { type: 'string', description: '私信收件人 mid；不填就发给主人。' },
      oid: { type: 'string', description: '评论区：目标 id（视频 aid / 动态 id）。' },
      type: { type: 'string', description: '评论区：目标类型，视频=1，动态=17。默认 1。' },
      root: { type: 'string', description: '评论区：楼中楼根评论 rpid（回复别人评论时带上）。' },
      parent: { type: 'string', description: '评论区：要回复的那条评论 rpid。' },
      message: { type: 'string', description: '评论区正文；回复别人评论时不要手打 @。' },
      rpid: { type: 'string', description: 'del：要删的评论 rpid。' },
      crop: { type: 'string', description: '发前裁剪，格式 left,top,right,bottom（像素）。' },
      go: { type: 'boolean', description: 'true 才真正上传/发送；默认 false 只做 dry-run。' },
    },
    async execute(args) {
      const a = []
      a.push(String(args.action || ''))
      if (args.file) a.push('--file', String(args.file))
      if (args.to) a.push('--to', String(args.to))
      if (args.oid) a.push('--oid', String(args.oid))
      if (args.type) a.push('--type', String(args.type))
      if (args.root) a.push('--root', String(args.root))
      if (args.parent) a.push('--parent', String(args.parent))
      if (args.message) a.push('--message', String(args.message))
      if (args.rpid) a.push('--rpid', String(args.rpid))
      if (args.crop) a.push('--crop', String(args.crop))
      a.push(args.go === true ? '--go' : '--dry')
      const r = await runCli(a)
      return r
    },
  }))
}
