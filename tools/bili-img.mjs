#!/usr/bin/env node
/**
 * bili-img.mjs —— 给鲸鱼娘用的「B站发图」小工具（私信发图 / 评论区发图）
 *
 *   node bili-img.mjs upload  --file <图片>            （只上传，打印图床 url）
 *   node bili-img.mjs dm      --file <图片> [--to <mid>] --dry|--go
 *   node bili-img.mjs comment --file <图片> --oid <id> --type <n> [--root <r>] [--parent <p>] [--message "正文"] --dry|--go
 *
 * 安全：私信默认只发主人（bili-whale 配置的 owner.mid）；一律默认 dry，加 --go 才真发。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const REF = 'https://www.bilibili.com/'
const HOME = os.homedir()
const CRED = path.join(HOME, '.bili-ai', 'credentials.json')
const DEVID = path.join(HOME, '.bili-ai', 'dev_id')
const OWNER_CFG = path.join(HOME, '.dsh', 'bili-whale.config.json')

const argv = process.argv.slice(2)
const cmd = argv[0]
function opt(name, def) {
  const i = argv.indexOf('--' + name)
  if (i < 0) return def
  const v = argv[i + 1]
  return v && !v.startsWith('--') ? v : true
}
const DRY = !argv.includes('--go')
const FILE = opt('file')
const MSG = typeof opt('msg') === 'string' ? opt('msg') : (typeof opt('message') === 'string' ? opt('message') : '')

function die(m) { console.error('✗ ' + m); return 2 }

function loadCred() {
  if (!fs.existsSync(CRED)) die('找不到凭据 ' + CRED + '（先在插件设置页扫码登录）')
  const raw = JSON.parse(fs.readFileSync(CRED, 'utf8'))
  const pick = (k) => {
    for (const key of Object.keys(raw)) if (key.toLowerCase() === k.toLowerCase()) return raw[key]
    return undefined
  }
  const c = {
    sessdata: pick('sessdata'), bili_jct: pick('bili_jct'), buvid3: pick('buvid3'),
    dedeuserid: pick('dedeuserid'), ckmd5: pick('dedeuserid__ckmd5'),
  }
  if (!c.sessdata || !c.bili_jct) die('凭据缺 SESSDATA 或 bili_jct，去设置页重新扫码登录')
  c.cookie = ['SESSDATA=' + c.sessdata, 'bili_jct=' + c.bili_jct, c.buvid3 ? 'buvid3=' + c.buvid3 : '',
    c.dedeuserid ? 'DedeUserID=' + c.dedeuserid : '', c.ckmd5 ? 'DedeUserID__ckMd5=' + c.ckmd5 : ''].filter(Boolean).join('; ')
  return c
}

function stableDevId() {
  try { const v = fs.readFileSync(DEVID, 'utf8').trim(); if (v) return v } catch (e) {}
  const v = String(Math.floor(Math.random() * 9000000) + 1000000) + String(process.hrtime.bigint()).slice(-8)
  try { fs.mkdirSync(path.dirname(DEVID), { recursive: true }); fs.writeFileSync(DEVID, v) } catch (e) {}
  return v
}

async function jget(url, cookie) {
  const r = await fetch(url, { headers: { 'user-agent': UA, referer: REF, cookie } })
  return r.json()
}

async function whoami(cookie) {
  const j = await jget('https://api.bilibili.com/x/web-interface/nav', cookie)
  if (!j || !j.data || !j.data.isLogin) die('登录态无效（code=' + (j && j.code) + ' ' + (j && j.message) + '）')
  return { mid: String(j.data.mid), uname: j.data.uname }
}

function ownerMid() {
  try { const cfg = JSON.parse(fs.readFileSync(OWNER_CFG, 'utf8')); const m = cfg && cfg.owner && cfg.owner.mid; if (m) return String(m) } catch (e) {}
  return ''
}

function mimeOf(p) {
  const e = path.extname(String(p)).toLowerCase()
  if (e === '.png') return 'image/png'
  if (e === '.gif') return 'image/gif'
  if (e === '.webp') return 'image/webp'
  return 'image/jpeg'
}

// ── 裁剪：--crop left,top,right,bottom（裁掉截图白边/边框再发）─────────
const CROP = (() => {
  const v = opt('crop')
  if (!v || v === true) return null
  const n = String(v).split(',').map((x) => parseInt(x, 10))
  if (n.length !== 4 || n.some((x) => !Number.isFinite(x) || x < 0)) die('--crop 要四个非负数：left,top,right,bottom')
  return n
})()

async function cropped(file, crop) {
  const l = crop[0], t = crop[1], rr = crop[2], b = crop[3]
  let jimp
  try {
    const { createRequire } = await import('node:module')
    const bases = [
      import.meta.url,
      path.join(HOME, '.dsh', 'profiles', 'desktop', 'package.json'),
    ]
    let lastErr = null
    for (const base of bases) {
      try { jimp = createRequire(base)('jimp'); break } catch (e) { lastErr = e }
    }
    if (!jimp) throw lastErr
  } catch (e) { die('要裁剪但找不到 jimp（npm i jimp 或装进 DSH profile 的 node_modules）：' + e.message) }
  const img = await jimp.Jimp.read(file)
  const w = img.bitmap.width - l - rr
  const h = img.bitmap.height - t - b
  if (w <= 0 || h <= 0) die('裁过头了（原图 ' + img.bitmap.width + 'x' + img.bitmap.height + '）')
  img.crop({ x: l, y: t, w, h })
  const out = path.join(os.tmpdir(), 'bili-img-crop-' + process.pid + (path.extname(String(file)) || '.jpg'))
  await img.write(out)
  console.log('  已裁: ' + img.bitmap.width + 'x' + img.bitmap.height + '（去掉 左' + l + ' 上' + t + ' 右' + rr + ' 下' + b + '）')
  return out
}

async function upload(file, cred) {
  if (!file || file === true || !fs.existsSync(file)) die('图片不存在：' + file)
  if (CROP) file = await cropped(file, CROP)
  const buf = fs.readFileSync(file)
  const mb = buf.length / 1024 / 1024
  if (mb > 20) die('图片超过 20MB（' + mb.toFixed(1) + 'MB）')
  const fd = new FormData()
  fd.append('file_up', new Blob([buf], { type: mimeOf(file) }), 'upload' + (path.extname(file) || '.jpg'))
  fd.append('category', 'daily')
  fd.append('csrf', String(cred.bili_jct))
  const r = await fetch('https://api.bilibili.com/x/dynamic/feed/draw/upload_bfs', {
    method: 'POST', headers: { 'user-agent': UA, referer: REF, cookie: cred.cookie }, body: fd,
  })
  const j = await r.json().catch(() => ({}))
  if (j.code !== 0) die('上传失败 code=' + j.code + ' ' + (j.message || '') + ' ' + JSON.stringify(j).slice(0, 200))
  const d = j.data || {}
  return { url: d.image_url, w: Number(d.image_width), h: Number(d.image_height), kb: Number(d.img_size) }
}

async function sendDmImage(cred, toMid, img, ext) {
  const me = await whoami(cred.cookie)
  if (String(me.mid) === String(toMid)) die('不能给自己发私信')
  const content = { url: img.url, width: img.w, height: img.h, imageType: ext, original: 1, size: img.kb }
  const body = new URLSearchParams()
  body.set('msg[sender_uid]', me.mid)
  body.set('msg[receiver_id]', String(toMid))
  body.set('msg[receiver_type]', '1')
  body.set('msg[msg_type]', '2')
  body.set('msg[msg_status]', '0')
  body.set('msg[timestamp]', String(Math.floor(Date.now() / 1000)))
  body.set('msg[dev_id]', stableDevId())
  body.set('msg[content]', JSON.stringify(content))
  body.set('csrf', String(cred.bili_jct))
  const r = await fetch('https://api.vc.bilibili.com/web_im/v1/web_im/send_msg', {
    method: 'POST',
    headers: { 'user-agent': UA, referer: 'https://message.bilibili.com/', 'content-type': 'application/x-www-form-urlencoded', cookie: cred.cookie },
    body: body.toString(),
  })
  const j = await r.json().catch(() => ({}))
  return { http: r.status, code: j.code, message: j.message, content }
}

async function postCommentImage(cred, oid, type, root, parent, message, img) {
  const pic = { img_src: img.url, img_width: img.w, img_height: img.h, img_size: img.kb }
  const fields = ['picture', 'pictures']
  let last = null
  for (const field of fields) {
    const body = new URLSearchParams()
    body.set('oid', String(oid))
    body.set('type', String(type))
    body.set('message', message || '')
    body.set('plat', '1')
    body.set('csrf', String(cred.bili_jct))
    if (root) body.set('root', String(root))
    if (parent) body.set('parent', String(parent))
    body.set(field, JSON.stringify([pic]))
    const r = await fetch('https://api.bilibili.com/x/v2/reply/add', {
      method: 'POST',
      headers: { 'user-agent': UA, referer: REF, 'content-type': 'application/x-www-form-urlencoded', cookie: cred.cookie },
      body: body.toString(),
    })
    const j = await r.json().catch(() => ({}))
    last = { http: r.status, code: j.code, message: j.message, field, rpid: (j.data && (j.data.rpid_str || j.data.rpid)) || null, raw: JSON.stringify(j).slice(0, 300) }
    if (j.code === 0) return last
    if (!/参数|picture|图片/.test(String(j.message || ''))) return last
  }
  return last
}

async function main() {
const HELP = ['用法：',
  '  node bili-img.mjs upload  --file <图片>',
  '  node bili-img.mjs dm      --file <图片> [--to <mid>] --dry|--go',
  '  node bili-img.mjs comment --file <图片> --oid <id> --type <n> [--root <r>] [--parent <p>] [--message "正文"] --dry|--go'].join('\n')

if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') { console.log(HELP); return 0 }

const cred = loadCred()

if (cmd === 'upload') {
  if (DRY) { console.log('[dry] 会上传 ' + FILE + '；真跑加 --go（上传本身也是写操作）'); return 0 }
  const img = await upload(FILE, cred)
  console.log(JSON.stringify(img, null, 2))
  return 0
}

if (cmd === 'dm') {
  const to = String(opt('to') || ownerMid() || '')
  if (!to) die('没给 --to，配置里也没 owner.mid')
  console.log('=== 私信发图 ===')
  console.log('  文件: ' + FILE)
  console.log('  收信: ' + to + (to === ownerMid() ? '（主人）' : ''))
  if (DRY) { console.log('\n[dry] 未上传、未发送。真跑加 --go'); return 0 }
  const img = await upload(FILE, cred)
  console.log('  已上传: ' + img.url + '  ' + img.w + 'x' + img.h + '  ' + img.kb + 'KB')
  const favicon = mimeOf(FILE).replace('image/', '')
  const re = await sendDmImage(cred, to, img, favicon)
  console.log('  HTTP ' + re.http + '  code=' + re.code + ' ' + (re.message || ''))
  console.log(re.code === 0 ? '\n✅ 私信图已发' : '\n✗ 发送失败: ' + JSON.stringify(re).slice(0, 300))
  return re.code === 0 ? 0 : 6
}

if (cmd === 'comment') {
  const oid = opt('oid'), type = opt('type') || '1', root = opt('root'), parent = opt('parent')
  if (!oid || oid === true) die('缺 --oid')
  console.log('=== 评论区发图 ===')
  console.log('  oid=' + oid + ' type=' + type + ' root=' + (root || '-') + ' parent=' + (parent || '-'))
  console.log('  文件: ' + FILE + '   正文: ' + (MSG || '（空）'))
  if (DRY) { console.log('\n[dry] 未上传、未发布。真跑加 --go'); return 0 }
  const img = await upload(FILE, cred)
  console.log('  已上传: ' + img.url + '  ' + img.w + 'x' + img.h)
  const re = await postCommentImage(cred, oid, type, root, parent, MSG, img)
  console.log('  HTTP ' + re.http + '  code=' + re.code + ' ' + re.message + '  field=' + re.field + '  rpid=' + (re.rpid || '-'))
  console.log(re.code === 0 ? '\n✅ 已发（rpid=' + re.rpid + '）' : '\n✗ 失败: ' + re.raw)
  return re.code === 0 ? 0 : 6
}

if (cmd === 'del') {
  // 删自己发过的评论（只用于撤回测试/发错的）：--oid --type --rpid
  const oid = opt('oid'), type = opt('type') || '1', rpid = opt('rpid')
  if (!oid || !rpid || oid === true || rpid === true) die('缺 --oid / --rpid')
  if (DRY) { console.log('[dry] 会删评论 rpid=' + rpid + '；真跑加 --go'); return 0 }
  const body = new URLSearchParams()
  body.set('oid', String(oid)); body.set('type', String(type)); body.set('rpid', String(rpid))
  body.set('csrf', String(cred.bili_jct))
  const r = await fetch('https://api.bilibili.com/x/v2/reply/del', {
    method: 'POST',
    headers: { 'user-agent': UA, referer: REF, 'content-type': 'application/x-www-form-urlencoded', cookie: cred.cookie },
    body: body.toString(),
  })
  const j = await r.json().catch(() => ({}))
  console.log('HTTP ' + r.status + ' code=' + j.code + ' ' + (j.message || ''))
  return j.code === 0 ? 0 : 6
}

die('未知命令: ' + cmd)
}
process.exitCode = (await main()) ?? 0
