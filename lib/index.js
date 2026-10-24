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

// @deepseek-ai/dsh-tools 由宿主提供（Harness 自己的 dsh/node_modules）。拿得到就用它的
// defineTool 做参数校验；拿不到就自己把属性表编译成 JSON Schema —— 两边都必须满足
// ToolService.register() 的契约：{ name, description, parameters, output:{schema,render}, execute }。
let defineTool = null
try {
  const mod = await import('@deepseek-ai/dsh-tools')
  if (typeof mod.defineTool === 'function') defineTool = mod.defineTool
} catch (e) {
  // 宿主没暴露这个包：退回本地编译，功能不受影响
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
    'node', // 先试 PATH，跨机器才通
    path.join(os.homedir(), '.dsh', 'node.exe'),
    'E:/java/node.exe',
    'C:/Program Files/nodejs/node.exe',
  ].filter(Boolean)
  for (const c of cands) {
    if (c === 'node') return c // PATH 里的 node 存在与否交给 execFile 报 ENOENT
    try { if (fs.existsSync(c)) return c } catch (e) {}
  }
  return 'node'
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

const DESCRIPTION = '在 B站 发图：私信发图（action=dm）、评论区发图（action=comment）、删自己发的评论（action=del）、只上传图床（action=upload）。图片可以先用 crop 参数裁掉截图边框（left,top,right,bottom 像素）。默认 dry-run，只回显将要做什么；真正发送必须显式 go=true。私信不写 to 就默认发给主人。'

/** 属性表：宿主 dsh-tools 的 defineTool 直接吃这个形状 */
const PARAMS = {
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
}

/** 没有宿主 dsh-tools 时，把属性表编译成注册表要的 JSON Schema */
function toJsonSchema(params) {
  const properties = {}
  const required = []
  for (const [key, spec] of Object.entries(params)) {
    const { required: isRequired, ...rest } = spec
    properties[key] = rest
    if (isRequired) required.push(key)
  }
  const schema = { type: 'object', properties }
  if (required.length > 0) schema.required = required
  return schema
}

/** 注册表要求 output:{schema,render}，render 把结果投影成给模型看的文本 */
function renderOutput(args, value) {
  if (typeof value === 'string') return value
  const out = []
  if (value && typeof value === 'object') {
    const lines = [value.stdout, value.stderr].filter((s) => s && String(s).trim())
    if (lines.length > 0) out.push(lines.join('\n'))
    if (value.ok === false) out.push('失败（exit ' + (value.code ?? '?') + '）')
  }
  if (out.length === 0) out.push(JSON.stringify(value, null, 2))
  return out.join('\n')
}

async function execute(args) {
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
  return runCli(a)
}

export function apply(ctx) {
  const core = {
    name: 'bili_send_image',
    description: DESCRIPTION,
    parameters: PARAMS,
    output: { schema: {}, render: renderOutput },
    execute,
  }
  const definition = defineTool ? defineTool(core) : { ...core, parameters: toJsonSchema(PARAMS) }
  ctx.tools.register(definition)
}
