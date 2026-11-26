// dsh-bvs-pets — host half.
//
// Serves the injected widget script, the pet catalogue API, and the animation
// files straight out of assets/. Everything lives under one prefix route so the
// registered surface stays small. Read-only: it never writes config.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const PREFIX = '/dsh-bvs-pets'
const ASSETS_DIR = path.join(ROOT, 'assets')
const WEB_DIR = path.join(ROOT, 'web')

const MIME = {
  '.webm': 'video/webm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.js': 'application/javascript; charset=utf-8',
}

const LABELS = { doubao: '豆包', deepseek: 'DeepSeek', chatgpt: 'ChatGPT', claude: 'Claude' }

function hostnameOf(value) {
  return String(value || '').trim().toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
}

function isLoopback(value) {
  const hn = hostnameOf(value)
  if (!hn) return false
  if (hn === 'localhost' || hn.endsWith('.localhost') || hn === '::1') return true
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hn)
  return Boolean(m) && [m[1], m[2], m[3]].every((x) => Number(x) <= 255)
}

// Read-only static files, but keep them on loopback to be safe.
function isTrustedRequest(req) {
  if (!isLoopback(req.headers.host)) return false
  if (String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return false
  const origin = req.headers.origin
  if (origin) {
    try {
      if (!isLoopback(new URL(origin).host)) return false
    } catch {
      return false
    }
  }
  return true
}

function sendJson(res, code, body) {
  const text = JSON.stringify(body)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(text),
  })
  res.end(text)
}

function assetUrl(id, file) {
  return `${PREFIX}/asset/${encodeURIComponent(id)}/${encodeURIComponent(file)}`
}

function readManifest(dir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'pet.json'), 'utf8'))
    return raw && typeof raw === 'object' ? raw : null
  } catch {
    return null
  }
}

/**
 * A window pet is a folder with pet.json. Each declared action maps to
 * `<name>.webm`. Folders without a manifest (and any name starting with
 * . or _) stay off stage.
 */
function listPets() {
  const pets = []
  let entries
  try {
    entries = fs.readdirSync(ASSETS_DIR, { withFileTypes: true })
  } catch {
    return pets
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const id = entry.name
    if (id.startsWith('.') || id.startsWith('_')) continue
    const dir = path.join(ASSETS_DIR, id)
    const manifest = readManifest(dir)
    if (!manifest) continue
    let files
    try {
      files = fs.readdirSync(dir)
    } catch {
      continue
    }
    const declared = manifest.actions && typeof manifest.actions === 'object' ? manifest.actions : {}
    const actions = {}
    const animations = {}
    for (const [name, spec] of Object.entries(declared)) {
      if (!spec || typeof spec !== 'object') continue
      if (!/^[a-z][a-z0-9_-]{0,31}$/i.test(name)) continue
      const file = `${name}.webm`
      if (!files.includes(file)) continue
      const url = assetUrl(id, file)
      actions[name] = {
        url,
        label: typeof spec.label === 'string' ? spec.label : '',
        play: spec.play === 'loop' ? 'loop' : 'once',
        then: spec.then === 'home' ? 'home' : 'hold',
        group: typeof spec.group === 'string' ? spec.group : '',
        cooldown: Number.isFinite(Number(spec.cooldown)) ? Math.max(0, Number(spec.cooldown)) : 0,
      }
      animations[name] = url
    }
    if (Object.keys(actions).length === 0) continue
    const entrance = typeof manifest.entrance === 'string' && actions[manifest.entrance]
      ? manifest.entrance
      : Object.keys(actions)[0]
    const home = typeof manifest.home === 'string' && actions[manifest.home] ? manifest.home : ''
    const displaySize = Number.isFinite(Number(manifest.displaySize))
      ? Math.max(80, Math.min(360, Math.round(Number(manifest.displaySize))))
      : 240
    let thumb = null
    if (files.includes('idle.png')) thumb = assetUrl(id, 'idle.png')
    else {
      const png = files.find((file) => path.extname(file).toLowerCase() === '.png')
      if (png) thumb = assetUrl(id, png)
    }
    pets.push({
      id,
      label: typeof manifest.label === 'string' && manifest.label ? manifest.label : (LABELS[id] || id),
      thumb,
      displaySize,
      entrance,
      home,
      actions,
      animations,
    })
  }
  pets.sort((a, b) => a.id.localeCompare(b.id))
  return pets
}

/** Parse a Range header; returns undefined for a plain 200 response. */
function parseRange(header, size) {
  if (typeof header !== 'string') return undefined
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (match === null) return undefined
  const [, rawStart, rawEnd] = match
  if (rawStart === '' && rawEnd === '') return undefined
  if (rawStart === '') {
    const length = Number(rawEnd)
    if (!Number.isFinite(length) || length <= 0) return undefined
    return { start: Math.max(size - length, 0), end: size - 1 }
  }
  const start = Number(rawStart)
  if (!Number.isFinite(start) || start >= size) return { unsatisfiable: true }
  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1)
  if (!Number.isFinite(end) || end < start) return { unsatisfiable: true }
  return { start, end }
}

/** Serve one file (range-capable) with the right content type. */
function serveFile(req, res, absolute) {
  let info
  try {
    info = fs.statSync(absolute)
  } catch {
    return sendJson(res, 404, { ok: false, error: 'not found' })
  }
  if (!info.isFile()) return sendJson(res, 404, { ok: false, error: 'not found' })
  const type = MIME[path.extname(absolute).toLowerCase()] || 'application/octet-stream'
  const range = parseRange(req.headers.range, info.size)
  if (range && range.unsatisfiable === true) {
    res.writeHead(416, { 'Content-Range': `bytes */${info.size}` })
    return res.end()
  }
  const from = range ? range.start : 0
  const to = range ? range.end : info.size - 1
  res.writeHead(range ? 206 : 200, {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'Content-Length': String(to - from + 1),
    ...(range ? { 'Content-Range': `bytes ${from}-${to}/${info.size}` } : {}),
  })
  if (req.method === 'HEAD') return res.end()
  const stream = fs.createReadStream(absolute, { start: from, end: to })
  stream.on('error', () => res.destroy())
  res.on('close', () => stream.destroy())
  stream.pipe(res)
}

export default {
  name: 'dsh-bvs-pets',

  apply(root) {
    // Desktop shell reads index.html from a static dist, so the only channel is
    // the structured `webserver/index-inject` table, collected once at boot.
    const disposers = []
    root.effect(() => () => {
      for (const dispose of disposers) {
        try { dispose() } catch {}
      }
    })

    disposers.push(root.on('webserver/index-inject', (table) => {
      try {
        if (!Array.isArray(table)) return
        const marker = `${PREFIX}/widget.js`
        const exists = table.some((row) => row && (
          (row.kind === 'script-src' && row.src === marker)
          || (row.kind === 'script' && typeof row.text === 'string' && row.text.includes(marker))
        ))
        if (exists) return
        table.push({
          kind: 'script',
          placement: 'body',
          text: '(function(){try{var d=document.body||document.head;if(!d)return;'
            + `var s=document.createElement("script");s.src="${marker}";`
            + 's.async=true;s.onerror=function(){};d.appendChild(s)}catch(e){}})()',
        })
      } catch {}
    }))

    root.inject(['webServer'], (ctx) => {
      disposers.push(ctx.webServer.register({
        kind: 'prefix',
        path: PREFIX,
        handler: (req, res) => {
          if (!isTrustedRequest(req)) return sendJson(res, 403, { ok: false, error: 'forbidden' })
          let url
          try {
            url = new URL(req.url || '/', 'http://localhost')
          } catch {
            return sendJson(res, 400, { ok: false, error: 'bad url' })
          }
          const rest = url.pathname.startsWith(`${PREFIX}/`) ? url.pathname.slice(PREFIX.length + 1) : ''

          if (rest === 'widget.js') return serveFile(req, res, path.join(WEB_DIR, 'widget.js'))
          if (rest === 'api/pets') return sendJson(res, 200, { ok: true, pets: listPets() })

          if (rest.startsWith('asset/')) {
            const parts = rest.slice('asset/'.length).split('/')
            if (parts.length !== 2) return sendJson(res, 404, { ok: false, error: 'not found' })
            let id, file
            try {
              id = decodeURIComponent(parts[0])
              file = decodeURIComponent(parts[1])
            } catch {
              return sendJson(res, 400, { ok: false, error: 'bad path' })
            }
            if (!id || !file || id !== path.basename(id) || file !== path.basename(file)) {
              return sendJson(res, 400, { ok: false, error: 'bad path' })
            }
            const dir = path.join(ASSETS_DIR, id)
            const absolute = path.resolve(dir, file)
            if (!absolute.startsWith(dir + path.sep)) return sendJson(res, 404, { ok: false, error: 'not found' })
            return serveFile(req, res, absolute)
          }

          return sendJson(res, 404, { ok: false, error: 'not found' })
        },
      }))
    })
  },
}
