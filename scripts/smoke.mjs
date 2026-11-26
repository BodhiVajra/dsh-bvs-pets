#!/usr/bin/env node
// Offline smoke test for the dsh-bvs-pets host plugin. Does not start DSH.

import assert from 'node:assert/strict'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Writable } from 'node:stream'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const host = (await import(join(root, 'lib/index.js'))).default

function makeResponse() {
  const chunks = []
  const res = new Writable({
    write(chunk, _enc, cb) { chunks.push(Buffer.from(chunk)); cb() },
  })
  res.status = 0
  res.headers = {}
  res.writeHead = function (status, headers) { this.status = status; this.headers = headers }
  res.collect = () => Buffer.concat(chunks)
  return res
}

function call(handler, url, headers) {
  return new Promise((resolvePromise, reject) => {
    const res = makeResponse()
    res.on('finish', () => resolvePromise({ status: res.status, headers: res.headers, body: res.collect() }))
    res.on('error', reject)
    const req = { method: 'GET', url, headers: headers || { host: '127.0.0.1' } }
    try { handler(req, res) } catch (error) { reject(error) }
  })
}

const routes = []
let injection = null
host.apply({
  effect(cb) { const r = cb(); return typeof r === 'function' ? r : () => {} },
  on(event, handler) { if (event === 'webserver/index-inject') injection = handler; return () => {} },
  inject(deps, cb) {
    assert.deepEqual(deps, ['webServer'])
    cb({ webServer: { register(route) { routes.push(route); return () => {} } } })
    return () => {}
  },
})

// 1. one prefix route
assert.equal(routes.length, 1)
assert.equal(routes[0].kind, 'prefix')
assert.equal(routes[0].path, '/dsh-bvs-pets')
const handler = routes[0].handler

// 2. injection pushes one script row pointing at widget.js
const table = []
injection(table)
assert.equal(table.length, 1)
assert.equal(table[0].kind, 'script')
assert.match(table[0].text, /dsh-bvs-pets\/widget.js/)

// 3. widget.js: 200 javascript + guard token
const w = await call(handler, '/dsh-bvs-pets/widget.js')
assert.equal(w.status, 200)
assert.match(w.headers['Content-Type'], /javascript/)
assert.match(w.body.toString('utf8'), /__DSH_MYPET_V2__/)

// 4. /api/pets: 200 JSON with the discovered characters
const api = await call(handler, '/dsh-bvs-pets/api/pets')
assert.equal(api.status, 200)
const payload = JSON.parse(api.body.toString('utf8'))
assert.equal(payload.ok, true)
assert.ok(Array.isArray(payload.pets) && payload.pets.length >= 1, 'no pets discovered')
for (const pet of payload.pets) {
  assert.ok(pet.id && pet.label, 'pet missing id/label')
  assert.ok(pet.animations && Object.keys(pet.animations).length > 0, 'pet missing animations')
  assert.ok(pet.thumb, 'pet missing thumb')
}
console.log('pets:', payload.pets.map((p) => `${p.id}(${Object.keys(p.animations).join(',')})`).join(' '))

// 5. asset: 200 video/webm + non-empty body
const first = payload.pets[0]
const animName = Object.keys(first.animations)[0]
const asset = await call(handler, first.animations[animName])
assert.equal(asset.status, 200)
assert.equal(asset.headers['Content-Type'], 'video/webm')
assert.ok(asset.body.length > 1000, `asset body too small: ${asset.body.length}`)

// 6. cross-site is rejected
const evil = await call(handler, '/dsh-bvs-pets/widget.js', {
  host: '127.0.0.1', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site',
})
assert.equal(evil.status, 403)

// 7. path traversal is rejected
const trav = await call(handler, '/dsh-bvs-pets/asset/doubao/../../package.json')
assert.ok(trav.status === 400 || trav.status === 404, `traversal not rejected: ${trav.status}`)

console.log('all smoke checks passed')
