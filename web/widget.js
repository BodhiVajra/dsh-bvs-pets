// dsh-bvs-pets — browser half.
//
// Renders the pets declared by pet.json. Each clip says whether it loops and
// what may interrupt it. State lives in localStorage; no host write.

(function () {
  'use strict'
  if (window.__DSH_MYPET_V2__) return
  window.__DSH_MYPET_V2__ = true

  var PREFIX = '/dsh-bvs-pets'
  var API = PREFIX + '/api/pets'
  var CONFIG_KEY = 'dsh-mypet.config.v1'
  var POS_PREFIX = 'dsh-mypet.pos.v2.'
  var MAX_ALLOWED = 8
  var DEFAULT_SIZE = 240

  var state = {
    pets: [],
    config: { selected: null, max: 2, size: DEFAULT_SIZE },
    nodes: {},
    panel: null,
    gear: null,
    menu: null,
    cursor: null,
    obstacles: [],
    obstacleAt: 0,
    frame: 0,
    destroyed: false,
  }

  // ---------------------------------------------------------------- config --

  function readConfig() {
    var raw = null
    try { raw = JSON.parse(localStorage.getItem(CONFIG_KEY) || 'null') } catch (e) {}
    var cfg = raw && typeof raw === 'object' ? raw : {}
    var selected = Array.isArray(cfg.selected)
      ? cfg.selected.filter(function (x) { return typeof x === 'string' })
      : null
    var max = Number.isFinite(cfg.max) ? Math.round(cfg.max) : 2
    var size = Number.isFinite(cfg.size) ? Math.round(cfg.size) : DEFAULT_SIZE
    return {
      selected: selected,
      max: Math.max(1, Math.min(MAX_ALLOWED, max)),
      size: Math.max(80, Math.min(360, size)),
    }
  }

  function writeConfig() {
    try { localStorage.setItem(CONFIG_KEY, JSON.stringify(state.config)) } catch (e) {}
  }

  function selectedIds() {
    if (state.config.selected) return state.config.selected
    return state.pets.map(function (p) { return p.id })
  }

  function setSelected(ids) {
    state.config.selected = ids.slice()
    writeConfig()
  }

  function isSelected(id) {
    return selectedIds().indexOf(id) !== -1
  }

  function visiblePets() {
    var ids = selectedIds()
    var chosen = state.pets.filter(function (p) { return ids.indexOf(p.id) !== -1 })
    return chosen.slice(0, state.config.max)
  }

  function statusOf(pet) {
    if (!isSelected(pet.id)) return 'hidden'
    var vis = visiblePets()
    for (var i = 0; i < vis.length; i += 1) {
      if (vis[i].id === pet.id) return 'shown'
    }
    return 'queued'
  }

  // ------------------------------------------------------------- positions --

  function readPos(id, index) {
    try {
      var raw = JSON.parse(localStorage.getItem(POS_PREFIX + id) || 'null')
      if (raw && Number.isFinite(raw.left) && Number.isFinite(raw.bottom)) return raw
    } catch (e) {}
    return { left: 16 + index * (state.config.size + 16), bottom: 16 }
  }

  function clampPos(pos) {
    var s = state.config.size
    var m = 6
    return {
      left: Math.min(Math.max(m, pos.left), Math.max(m, window.innerWidth - s - m)),
      bottom: Math.min(Math.max(m, pos.bottom), Math.max(m, window.innerHeight - s - m)),
    }
  }

  function applyPos(node, pos) {
    var p = clampPos(pos)
    node.host.style.left = p.left + 'px'
    node.host.style.bottom = p.bottom + 'px'
    node.host.style.right = 'auto'
    node.host.style.top = 'auto'
    node.pos = p
    return p
  }

  // -------------------------------------------------------------- playback --

  function actionOf(pet, name) {
    return pet.actions && pet.actions[name]
  }

  function namesInGroup(pet, group) {
    var actions = pet.actions || {}
    return Object.keys(actions).filter(function (name) { return actions[name].group === group })
  }

  function isRest(node) {
    if (node.dragging) return false
    if (node.mode === 'hold') return true
    var action = actionOf(node.pet, node.current)
    return !!(action && action.play === 'loop' && node.pet.home && node.current === node.pet.home)
  }

  function clearAmbient(node) {
    if (node.ambientTimer) clearTimeout(node.ambientTimer)
    node.ambientTimer = 0
  }

  function clipByGroup(pet, group) {
    var actions = pet.actions || {}
    var names = Object.keys(actions)
    for (var i = 0; i < names.length; i += 1) {
      if (actions[names[i]].group === group) return names[i]
    }
    return ''
  }

  function expressionNames(pet) {
    var actions = pet.actions || {}
    return Object.keys(actions).filter(function (name) {
      var group = actions[name].group
      return group === 'social' || group === 'meal' || group === 'protest' || group === 'block'
    })
  }

  function cooled(node, name) {
    var action = actionOf(node.pet, name)
    var wait = ((action && action.cooldown) || 0) * 1000
    return Date.now() - (node.playedAt[name] || 0) >= wait
  }

  // Another expression, not the one on screen, whose cooldown has elapsed.
  function pickExpression(node) {
    var ready = expressionNames(node.pet).filter(function (name) {
      return name !== node.current && cooled(node, name)
    })
    if (!ready.length) return ''
    return ready[Math.floor(Math.random() * ready.length)]
  }

  function soonestExpression(node) {
    var names = expressionNames(node.pet)
    var best = Infinity
    for (var i = 0; i < names.length; i += 1) {
      if (names[i] === node.current) continue
      var action = actionOf(node.pet, names[i])
      var at = (node.playedAt[names[i]] || 0) + ((action && action.cooldown) || 0) * 1000
      if (at < best) best = at
    }
    return best
  }

  // Hold the finished pose, then start another expression on her own.
  function armAmbient(node) {
    node.nextExpression = performance.now() + 3200 + Math.random() * 4200
  }

  var ACTION_LABELS = {
    shy: '害羞', sajiao: '撒娇', eat: '吃饭', angry: '生气',
    cute: '装可爱', sad: '伤心', argue: '狡辩', show: '表现',
    walk: '走路', jog: '小跑', dodge: '躲避', block: '阻拦',
  }

  function actionLabel(action, name) {
    return (action && action.label) || ACTION_LABELS[name] || name
  }

  function finishClip(node) {
    var action = actionOf(node.pet, node.current)
    if (action && action.then === 'home' && node.pet.home && node.pet.home !== node.current) {
      play(node, node.pet.home)
      return
    }
    node.mode = 'hold'
    node.held = node.current
    try { node.video.pause() } catch (e) {}
    node.nextWander = performance.now() + 900 + Math.random() * 1200
    armAmbient(node)
  }

  function play(node, name) {
    var action = actionOf(node.pet, name)
    if (!action || !action.url) return
    clearAmbient(node)
    node.nextExpression = Infinity
    node.playSeq = (node.playSeq || 0) + 1
    var seq = node.playSeq
    node.ignoreEnded = true
    node.current = name
    node.mode = 'playing'
    if (action.group !== 'carry') {
      node.previous = name
      node.playedAt[name] = Date.now()
      if (action.group === 'social') node.lastSocial = name
    }
    node.video.loop = action.play === 'loop'
    setFace(node, node.face || 1)
    if (node.video.getAttribute('src') !== action.url) {
      node.video.setAttribute('src', action.url)
    } else {
      try { node.video.currentTime = 0 } catch (e) {}
    }
    node.video.addEventListener('playing', function onPlaying() {
      node.video.removeEventListener('playing', onPlaying)
      if (node.playSeq !== seq) return
      node.ignoreEnded = false
    })
    var started = node.video.play()
    if (started && started.catch) started.catch(function () {})
  }

  function restoreClip(node, snap) {
    var action = actionOf(node.pet, snap.name)
    if (!action) return
    node.current = snap.name
    node.mode = snap.mode
    node.video.loop = !!snap.loop
    function seek() {
      try { node.video.currentTime = snap.time } catch (e) {}
      if (snap.mode === 'playing') {
        var started = node.video.play()
        if (started && started.catch) started.catch(function () {})
      } else {
        try { node.video.pause() } catch (e) {}
        node.nextWander = performance.now() + 900
      }
      node.ignoreEnded = false
    }
    if (node.video.getAttribute('src') !== action.url) {
      node.video.setAttribute('src', action.url)
      node.video.addEventListener('loadeddata', function once() {
        node.video.removeEventListener('loadeddata', once)
        seek()
      })
    } else {
      seek()
    }
  }

  function setFace(node, dir) {
    if (dir) node.face = dir < 0 ? -1 : 1
    var action = actionOf(node.pet, node.current)
    var mirror = action && (action.group === 'walk' || action.group === 'jog' || action.group === 'dodge') && node.face < 0
    node.video.style.transform = mirror ? 'scaleX(-1)' : ''
  }

  function openMenu(node) {
    node.pointerSince = Date.now()
    node.glide = null
    node.pressing = false
    if (!state.menu || state.menu.node !== node) toggleMenu(node)
    else closeMenu()
  }

  function closeMenu() {
    if (!state.menu) return
    state.menu.node.menuOpen = false
    if (state.menu.host.parentNode) state.menu.host.parentNode.removeChild(state.menu.host)
    state.menu = null
  }

  function placeMenu(node) {
    if (!state.menu || state.menu.node !== node) return
    var width = 132
    var left = Math.min(Math.max(8, node.pos.left), Math.max(8, window.innerWidth - width - 8))
    var bottom = node.pos.bottom + state.config.size + 8
    var host = state.menu.host
    var height = host.offsetHeight || 280
    host.style.left = left + 'px'
    if (bottom + height > window.innerHeight) {
      host.style.bottom = 'auto'
      host.style.top = Math.max(8, window.innerHeight - node.pos.bottom - 8) + 'px'
    } else {
      host.style.top = 'auto'
      host.style.bottom = bottom + 'px'
    }
  }

  var MENU_STYLE = [
    ':host{all:initial}',
    '.card{display:flex;flex-direction:column;gap:2px;padding:6px;min-width:108px;',
    '  background:#fff;border:1px solid rgba(0,0,0,.10);border-radius:12px;',
    '  box-shadow:0 10px 28px rgba(0,0,0,.16)}',
    'button{all:unset;cursor:pointer;display:block;padding:6px 10px;border-radius:8px;',
    '  font:13px/1.35 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;color:#1f2328}',
    'button:hover{background:rgba(0,0,0,.06)}',
    '@media (prefers-color-scheme: dark){',
    '  .card{background:#1c1d20;border-color:rgba(255,255,255,.10)}',
    '  button{color:#e6e6e6}button:hover{background:rgba(255,255,255,.08)}',
    '}',
  ].join('')

  function toggleMenu(node) {
    if (state.menu && state.menu.node === node) { closeMenu(); return }
    closeMenu()
    var names = expressionNames(node.pet)
    if (!names.length) return
    var host = document.createElement('div')
    host.className = 'dsh-mypet-menu'
    host.style.cssText = 'position:fixed;z-index:2147482004;'
    var shadow = host.attachShadow({ mode: 'open' })
    var buttons = names.map(function (name) {
      var action = actionOf(node.pet, name)
      return '<button type="button" data-name="' + escapeAttr(name) + '">'
        + escapeAttr(actionLabel(action, name)) + '</button>'
    }).join('')
    shadow.innerHTML = '<style>' + MENU_STYLE + '</style><div class="card">' + buttons + '</div>'
    shadow.addEventListener('click', function (event) {
      var button = event.target.closest ? event.target.closest('button') : null
      if (!button || !button.dataset.name) return
      play(node, button.dataset.name)
      closeMenu()
    })
    node.menuOpen = true
    state.menu = { host: host, node: node }
    document.body.appendChild(host)
    placeMenu(node)
  }

  function boxAt(left, bottom) {
    var s = state.config.size
    var top = window.innerHeight - bottom - s
    return { left: left, top: top, right: left + s, bottom: top + s }
  }

  function hitsObstacle(left, bottom) {
    var b = boxAt(left, bottom)
    var list = state.obstacles || []
    for (var i = 0; i < list.length; i += 1) {
      var o = list[i]
      if (b.left < o.right && b.right > o.left && b.top < o.bottom && b.bottom > o.top) return true
    }
    return false
  }

  function refreshObstacles(now) {
    if (now - state.obstacleAt < 400) return
    state.obstacleAt = now
    var rects = []
    function add(el, pad) {
      if (!el) return
      var r = el.getBoundingClientRect()
      if (r.width < 8 || r.height < 8) return
      rects.push({
        left: r.left - pad, top: r.top - pad,
        right: r.right + pad, bottom: r.bottom + pad,
      })
    }
    if (state.gear) add(state.gear.host, 12)
    if (state.panel && state.panel.host.style.display !== 'none') add(state.panel.host, 16)
    var nodes = document.body.querySelectorAll('div, aside, nav, section, header')
    var seen = 0
    for (var i = 0; i < nodes.length && seen < 220; i += 1) {
      var el = nodes[i]
      if (!el.classList) continue
      if (el.classList.contains('dsh-mypet-pet') || el.classList.contains('dsh-mypet-gear')
        || el.classList.contains('dsh-mypet-panel') || el.classList.contains('dsh-mypet-menu')) continue
      if (el.offsetWidth < 140 || el.offsetHeight < 72) continue
      seen += 1
      var cs
      try { cs = window.getComputedStyle(el) } catch (e) { continue }
      if (!cs || (cs.position !== 'fixed' && cs.position !== 'sticky')) continue
      if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue
      if (el.offsetWidth * el.offsetHeight > window.innerWidth * window.innerHeight * 0.72) continue
      add(el, 10)
      if (rects.length > 14) break
    }
    state.obstacles = rects
  }

  function standBottom(left) {
    var bottom = 16
    if (!hitsObstacle(left, bottom)) return bottom
    for (var lift = 48; lift <= 240; lift += 48) {
      if (!hitsObstacle(left, bottom + lift)) return bottom + lift
    }
    return bottom
  }

  function clearSpot(left) {
    var spot = clampPos({ left: left, bottom: standBottom(left) })
    if (hitsObstacle(spot.left, spot.bottom)) return null
    return spot
  }

  function remember(node) {
    try { localStorage.setItem(POS_PREFIX + node.pet.id, JSON.stringify(node.pos)) } catch (e) {}
  }

  function beginGlide(node, left, bottom, kind) {
    var to = clampPos({ left: left, bottom: bottom })
    var dx = to.left - node.pos.left
    var dy = to.bottom - node.pos.bottom
    if (Math.hypot(dx, dy) < 8) return
    var far = Math.abs(dx) > 380 && clipByGroup(node.pet, 'jog')
    var speed = kind === 'dodge' ? 240 : far ? 168 : 92
    node.glide = {
      from: { left: node.pos.left, bottom: node.pos.bottom },
      to: to,
      start: performance.now(),
      dur: Math.max(280, (Math.hypot(dx, dy) / speed) * 1000),
      kind: kind,
    }
    setFace(node, dx || node.face || 1)
    var current = actionOf(node.pet, node.current)
    var moving = current && (current.group === 'walk' || current.group === 'jog')
    if (!isRest(node) && !(kind === 'dodge' && moving)) return
    var name = ''
    if (kind === 'dodge') name = clipByGroup(node.pet, 'dodge') || clipByGroup(node.pet, 'jog') || clipByGroup(node.pet, 'walk')
    else if (far) name = clipByGroup(node.pet, 'jog')
    else name = clipByGroup(node.pet, 'walk')
    if (name && node.current !== name) play(node, name)
  }

  function restoreHeld(node) {
    var action = actionOf(node.pet, node.held)
    if (!action) { node.mode = 'hold'; return }
    node.current = node.held
    node.mode = 'hold'
    node.video.loop = false
    setFace(node, 1)
    function park() {
      try {
        if (node.video.duration) node.video.currentTime = Math.max(0, node.video.duration - 0.05)
      } catch (e) {}
      try { node.video.pause() } catch (e) {}
    }
    if (node.video.getAttribute('src') !== action.url) {
      node.ignoreEnded = true
      node.video.setAttribute('src', action.url)
      node.video.addEventListener('loadeddata', function once() {
        node.video.removeEventListener('loadeddata', once)
        park()
        node.ignoreEnded = false
      })
    } else {
      park()
    }
  }

  function finishGlide(node) {
    node.glide = null
    remember(node)
    var action = actionOf(node.pet, node.current)
    if (action && (action.group === 'walk' || action.group === 'jog' || action.group === 'dodge')) {
      if (node.pet.home && node.pet.home !== node.current) play(node, node.pet.home)
      else if (node.held && node.held !== node.current) restoreHeld(node)
      else {
        node.mode = 'hold'
        try { node.video.pause() } catch (e) {}
      }
    }
    node.nextWander = performance.now() + 1600 + Math.random() * 2400
  }

  function cursorNear(node) {
    var cursor = state.cursor
    if (!cursor) return false
    var s = state.config.size
    var cx = node.pos.left + s / 2
    var cy = window.innerHeight - node.pos.bottom - s / 2
    return Math.hypot(cursor.x - cx, cursor.y - cy) < s * 0.36
  }

  function stepPet(node, now) {
    if (!node.host.isConnected || node.dragging || node.menuOpen || node.pressing) {
      node.glide = null
      node.hoverSince = 0
      return
    }
    var dodging = node.glide && node.glide.kind === 'dodge' && now - node.glide.start < 520
    if (!dodging && cursorNear(node)) {
      if (!node.hoverSince) node.hoverSince = now
      if (now - node.hoverSince > 180) {
        var dir = (node.pos.left + state.config.size / 2) < state.cursor.x ? -1 : 1
        var left = node.pos.left + dir * (150 + Math.random() * 80)
        var spot = clearSpot(left) || clampPos({ left: left, bottom: 16 })
        beginGlide(node, spot.left, spot.bottom, 'dodge')
        if (!node.glide && isRest(node)) {
          var block = clipByGroup(node.pet, 'block')
          if (block && node.current !== block && cooled(node, block)) play(node, block)
        }
      }
    } else if (!cursorNear(node)) {
      node.hoverSince = 0
    }
    if (!node.glide && hitsObstacle(node.pos.left, node.pos.bottom)) {
      var away = node.pos.left + (node.pos.left < window.innerWidth / 2 ? 200 : -200)
      var clear = clearSpot(away) || clampPos({ left: away, bottom: standBottom(away) })
      beginGlide(node, clear.left, clear.bottom, 'dodge')
    }
    if (!node.glide && isRest(node) && now >= (node.nextExpression || Infinity)) {
      var next = pickExpression(node)
      if (next) play(node, next)
      else {
        var at = soonestExpression(node)
        node.nextExpression = now + (Number.isFinite(at) ? Math.max(400, at - Date.now()) : 4000)
      }
    }
    if (!node.glide && isRest(node) && now >= (node.nextWander || 0)) {
      var spot = null
      for (var n = 0; n < 8 && !spot; n += 1) {
        var left = 16 + Math.random() * Math.max(40, window.innerWidth - state.config.size - 32)
        if (Math.abs(left - node.pos.left) < 64) left += left < window.innerWidth / 2 ? 120 : -120
        spot = clearSpot(left)
      }
      if (spot) beginGlide(node, spot.left, spot.bottom, 'wander')
      if (!node.glide) node.nextWander = now + 1800
    }
    if (!node.glide) return
    var g = node.glide
    var t = Math.min(1, (now - g.start) / g.dur)
    var eased = t * t * (3 - 2 * t)
    applyPos(node, {
      left: g.from.left + (g.to.left - g.from.left) * eased,
      bottom: g.from.bottom + (g.to.bottom - g.from.bottom) * eased,
    })
    if (t >= 1) finishGlide(node)
  }

  function tick(now) {
    if (state.destroyed) return
    refreshObstacles(now)
    Object.keys(state.nodes).forEach(function (id) { stepPet(state.nodes[id], now) })
    state.frame = requestAnimationFrame(tick)
  }

  // ------------------------------------------------------------------ pets --

  var PET_STYLE = [
    ':host{all:initial}',
    '.wrap{',
    '  width:var(--s,160px);height:var(--s,160px);',
    '  cursor:grab;user-select:none;-webkit-user-select:none;touch-action:none;',
    '  display:block;',
    '}',
    '.wrap.dragging{cursor:grabbing}',
    '.wrap video{width:100%;height:100%;display:block;pointer-events:none;transform-origin:50% 72%}',
    '.wrap .fallback{display:none;width:100%;height:100%;border-radius:50%;',
    '  background:radial-gradient(circle at 50% 35%,#a5d8ff,#3b82f6 70%);',
    '  box-shadow:0 6px 18px rgba(0,0,0,.16)}',
    '.wrap.no-asset video{display:none}',
    '.wrap.no-asset .fallback{display:block}',
  ].join('')

  function createPet(pet, index) {
    var host = document.createElement('div')
    host.className = 'dsh-mypet-pet'
    host.style.cssText = 'position:fixed;z-index:2147482000;'
    var shadow = host.attachShadow({ mode: 'open' })
    shadow.innerHTML = '<style>' + PET_STYLE + '</style>'
      + '<div class="wrap" title="' + escapeAttr(pet.label) + '（右键选择表情，拖动可移动）">'
      + '<video muted playsinline autoplay loop></video><div class="fallback"></div></div>'

    var wrap = shadow.querySelector('.wrap')
    var video = shadow.querySelector('video')

    var node = {
      pet: pet,
      host: host,
      wrap: wrap,
      video: video,
      current: '',
      mode: '',
      held: '',
      previous: '',
      lastSocial: '',
      playedAt: {},
      pointerSince: Date.now(),
      pos: { left: 0, bottom: 0 },
      dragging: false,
      pressing: false,
      ambientTimer: 0,
      resume: null,
      glide: null,
      nextWander: 0,
      nextExpression: Infinity,
      hoverSince: 0,
      face: 1,
      menuOpen: false,
    }

    wrap.style.setProperty('--s', state.config.size + 'px')
    applyPos(node, readPos(pet.id, index))

    // ---- pointers -------------------------------------------------------
    var drag = null
    wrap.addEventListener('pointerdown', function (event) {
      if (event.button !== 0) return
      node.pressing = true
      drag = {
        x: event.clientX, y: event.clientY,
        left: node.pos.left, bottom: node.pos.bottom,
        id: event.pointerId, moved: false,
      }
      try { wrap.setPointerCapture(event.pointerId) } catch (e) {}
      event.preventDefault()
    })
    wrap.addEventListener('pointermove', function (event) {
      if (!drag || event.pointerId !== drag.id) return
      var dx = event.clientX - drag.x
      var dy = event.clientY - drag.y
      if (!drag.moved && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) {
        drag.moved = true
        wrap.classList.add('dragging')
        node.dragging = true
        node.glide = null
        closeMenu()
        clearAmbient(node)
        var carry = namesInGroup(node.pet, 'carry')[0]
        if (carry) {
          node.resume = {
            name: node.current,
            time: node.video.currentTime || 0,
            mode: node.mode,
            loop: node.video.loop,
          }
          play(node, carry)
        }
      }
      if (drag.moved) {
        applyPos(node, { left: drag.left + dx, bottom: drag.bottom - dy })
      }
    })
    function endDrag(event) {
      if (!drag || (event && event.pointerId !== drag.id)) return
      var moved = drag.moved
      drag = null
      wrap.classList.remove('dragging')
      node.dragging = false
      node.pressing = false
      try { localStorage.setItem(POS_PREFIX + node.pet.id, JSON.stringify(node.pos)) } catch (e) {}
      if (moved) {
        node.pointerSince = Date.now()
        node.nextWander = performance.now() + 1400
        node.nextExpression = Math.max(node.nextExpression || 0, performance.now() + 1600)
        var snap = node.resume
        node.resume = null
        if (snap) restoreClip(node, snap)
      }
    }
    wrap.addEventListener('pointerup', endDrag)
    wrap.addEventListener('pointercancel', endDrag)
    wrap.addEventListener('contextmenu', function (event) {
      event.preventDefault()
      event.stopPropagation()
      drag = null
      wrap.classList.remove('dragging')
      node.dragging = false
      openMenu(node)
    })

    video.addEventListener('error', function () {
      wrap.classList.add('no-asset')
    })
    video.addEventListener('ended', function () {
      if (node.ignoreEnded || node.video.loop || node.mode !== 'playing') return
      finishClip(node)
    })

    state.nodes[pet.id] = node
    document.body.appendChild(host)
    var entrance = node.pet.entrance && actionOf(node.pet, node.pet.entrance)
      ? node.pet.entrance
      : Object.keys(node.pet.actions || {})[0]
    if (entrance) play(node, entrance)
    return node
  }

  function destroyPet(id) {
    var node = state.nodes[id]
    if (!node) return
    if (state.menu && state.menu.node === node) closeMenu()
    clearAmbient(node)
    try { node.video.pause() } catch (e) {}
    try { node.video.removeAttribute('src') } catch (e) {}
    if (node.host.parentNode) node.host.parentNode.removeChild(node.host)
    delete state.nodes[id]
  }

  function updateSize() {
    Object.keys(state.nodes).forEach(function (id) {
      var node = state.nodes[id]
      node.wrap.style.setProperty('--s', state.config.size + 'px')
      applyPos(node, node.pos)
    })
  }

  function applyLayout() {
    var vis = visiblePets()
    var keep = {}
    vis.forEach(function (p) { keep[p.id] = true })
    Object.keys(state.nodes).forEach(function (id) {
      if (!keep[id]) destroyPet(id)
    })
    vis.forEach(function (pet, index) {
      if (!state.nodes[pet.id]) createPet(pet, index)
      else applyPos(state.nodes[pet.id], state.nodes[pet.id].pos)
    })
    updateSize()
    refreshPanel()
  }

  // ----------------------------------------------------------------- panel --

  var PANEL_STYLE = [
    ':host{all:initial}',
    '.card{',
    '  width:300px;max-height:78vh;overflow:auto;',
    '  font:12.5px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;',
    '  color:#1f2328;background:#fff;border:1px solid rgba(0,0,0,.10);border-radius:14px;',
    '  box-shadow:0 12px 34px rgba(0,0,0,.18);padding:12px 13px;',
    '}',
    '.hd{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}',
    '.hd b{font-size:13px;font-weight:650}',
    '.x{all:unset;cursor:pointer;color:#9ca3af;font-size:15px;line-height:1;padding:2px}',
    '.x:hover{color:#4b5563}',
    '.row{display:flex;align-items:center;gap:9px;padding:5px 4px;border-radius:9px}',
    '.row:hover{background:rgba(0,0,0,.035)}',
    '.row img{width:34px;height:34px;object-fit:contain;border-radius:8px;background:rgba(0,0,0,.04);flex:0 0 auto}',
    '.row .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.row .st{font-size:10.5px;color:#9ca3af;white-space:nowrap}',
    '.row .st.shown{color:#16a34a}',
    '.row .st.queued{color:#d97706}',
    'input[type=checkbox]{all:unset;cursor:pointer;width:15px;height:15px;border-radius:5px;',
    '  border:1.5px solid #cbd5e1;display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto}',
    'input[type=checkbox]:checked{background:#3b82f6;border-color:#3b82f6}',
    'input[type=checkbox]:checked::after{content:"";width:7px;height:4px;border-left:2px solid #fff;border-bottom:2px solid #fff;transform:rotate(-45deg) translateY(-1px)}',
    '.sep{height:1px;background:rgba(0,0,0,.07);margin:9px 0}',
    '.lab{color:#6b7280;margin-right:auto}',
    '.cap{display:flex;align-items:center;gap:6px}',
    '.cap button{all:unset;cursor:pointer;width:22px;height:22px;border-radius:7px;text-align:center;',
    '  line-height:22px;background:rgba(0,0,0,.05);color:#374151}',
    '.cap button:hover{background:rgba(0,0,0,.09)}',
    '.cap b{min-width:14px;text-align:center;font-variant-numeric:tabular-nums}',
    '.acts{display:flex;gap:7px;margin-top:9px}',
    '.acts button{all:unset;cursor:pointer;flex:1;text-align:center;padding:5px 0;border-radius:8px;',
    '  background:rgba(0,0,0,.05);color:#374151}',
    '.acts button:hover{background:rgba(0,0,0,.09)}',
    '.note{margin-top:7px;color:#9ca3af;font-size:11px;line-height:1.45}',
    '@media (prefers-color-scheme: dark){',
    '  .card{background:#1c1d20;color:#e6e6e6;border-color:rgba(255,255,255,.10)}',
    '  .row:hover{background:rgba(255,255,255,.05)}',
    '  .row img{background:rgba(255,255,255,.06)}',
    '  .sep{background:rgba(255,255,255,.09)}',
    '  .lab,.note{color:#9b9b9b}',
    '  .cap button,.acts button{background:rgba(255,255,255,.08);color:#d1d5db}',
    '}',
  ].join('')

  function escapeAttr(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
      .replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }

  function mountPanel() {
    var host = document.createElement('div')
    host.className = 'dsh-mypet-panel'
    host.style.cssText = 'position:fixed;z-index:2147482005;right:18px;top:50%;transform:translateY(-50%);display:none;'
    var shadow = host.attachShadow({ mode: 'open' })
    shadow.innerHTML = '<style>' + PANEL_STYLE + '</style>'
      + '<div class="card">'
      + '<div class="hd"><b>桌宠管理</b><button class="x" title="收起">×</button></div>'
      + '<div class="list"></div>'
      + '<div class="sep"></div>'
      + '<div class="row"><span class="lab">最多同时显示</span><span class="cap">'
      + '<button class="minus" title="减少">−</button><b class="maxv">2</b><button class="plus" title="增加">＋</button>'
      + '</span></div>'
      + '<div class="acts"><button class="all">全部启用</button><button class="none">全部禁用</button></div>'
      + '<div class="note">勾选要养的宠物；超过上限的会排队，不会同时出现。</div>'
      + '</div>'

    var list = shadow.querySelector('.list')
    var maxv = shadow.querySelector('.maxv')

    shadow.querySelector('.x').addEventListener('click', function () { setPanel(false) })
    shadow.querySelector('.minus').addEventListener('click', function () {
      state.config.max = Math.max(1, state.config.max - 1)
      writeConfig(); applyLayout()
    })
    shadow.querySelector('.plus').addEventListener('click', function () {
      var cap = Math.max(1, Math.min(MAX_ALLOWED, state.pets.length || MAX_ALLOWED))
      state.config.max = Math.min(cap, state.config.max + 1)
      writeConfig(); applyLayout()
    })
    shadow.querySelector('.all').addEventListener('click', function () {
      setSelected(state.pets.map(function (p) { return p.id })); applyLayout()
    })
    shadow.querySelector('.none').addEventListener('click', function () {
      setSelected([]); applyLayout()
    })

    list.addEventListener('click', function (event) {
      var row = event.target.closest ? event.target.closest('.row') : null
      if (!row || !row.dataset.id) return
      var id = row.dataset.id
      var box = row.querySelector('input')
      if (!box) return
      var ids = selectedIds().slice()
      var at = ids.indexOf(id)
      if (at === -1) ids.push(id)
      else ids.splice(at, 1)
      setSelected(ids)
      applyLayout()
    })

    state.panel = { host: host, shadow: shadow, list: list, maxv: maxv }
    document.body.appendChild(host)
  }

  function refreshPanel() {
    var p = state.panel
    if (!p) return
    p.maxv.textContent = String(state.config.max)
    if (state.pets.length === 0) {
      p.list.innerHTML = '<div class="note">未发现在 assets/ 下找到任何素材。</div>'
      return
    }
    var html = ''
    state.pets.forEach(function (pet) {
      var status = statusOf(pet)
      var label = status === 'shown' ? '显示中' : status === 'queued' ? '排队中' : '已隐藏'
      var checked = isSelected(pet.id) ? ' checked' : ''
      html += '<div class="row" data-id="' + escapeAttr(pet.id) + '">'
        + '<img src="' + escapeAttr(pet.thumb || '') + '" alt="">'
        + '<span class="nm">' + escapeAttr(pet.label) + '</span>'
        + '<span class="st ' + status + '">' + label + '</span>'
        + '<input type="checkbox"' + checked + '>'
        + '</div>'
    })
    p.list.innerHTML = html
  }

  function setPanel(open) {
    if (!state.panel) return
    state.panel.host.style.display = open ? 'block' : 'none'
  }

  function togglePanel() {
    if (!state.panel) return
    setPanel(state.panel.host.style.display === 'none')
  }

  function mountGear() {
    var el = document.createElement('div')
    el.className = 'dsh-mypet-gear'
    el.style.cssText = 'position:fixed;z-index:2147482006;right:18px;bottom:18px;'
    var shadow = el.attachShadow({ mode: 'open' })
    shadow.innerHTML = [
      '<style>',
      ':host{all:initial}',
      '.btn{width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;',
      '  background:rgba(255,255,255,.92);border:1px solid rgba(0,0,0,.10);',
      '  box-shadow:0 4px 14px rgba(0,0,0,.14);cursor:pointer;opacity:.55;transition:opacity .15s}',
      '.btn:hover{opacity:1}',
      'svg{width:15px;height:15px;fill:none;stroke:#4b5563;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}',
      '@media (prefers-color-scheme: dark){.btn{background:rgba(40,41,46,.92);border-color:rgba(255,255,255,.12)}svg{stroke:#c8c8c8}}',
      '</style>',
      '<div class="btn" title="桌宠管理"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/>',
      '<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></div>',
    ].join('')
    shadow.querySelector('.btn').addEventListener('click', function (event) {
      event.stopPropagation()
      togglePanel()
    })
    state.gear = { host: el }
    document.body.appendChild(el)
  }

  // ------------------------------------------------------------------ boot --

  function fetchPets() {
    return fetch(API, { cache: 'no-store', credentials: 'same-origin' })
      .then(function (res) { return res.json() })
      .then(function (data) {
        state.pets = Array.isArray(data && data.pets) ? data.pets : []
      })
      .catch(function () {
        state.pets = []
      })
  }

  function mount() {
    if (!document.body) { setTimeout(mount, 60); return }
    state.config = readConfig()
    mountPanel()
    mountGear()
    fetchPets().then(function () {
      // Drop stale ids that no longer have assets.
      if (state.config.selected) {
        var live = state.pets.map(function (p) { return p.id })
        state.config.selected = state.config.selected.filter(function (id) { return live.indexOf(id) !== -1 })
        writeConfig()
      }
      applyLayout()
    })
    window.addEventListener('resize', function () {
      Object.keys(state.nodes).forEach(function (id) {
        applyPos(state.nodes[id], state.nodes[id].pos)
      })
      if (state.menu) placeMenu(state.menu.node)
    })
    window.addEventListener('pointermove', function (event) {
      state.cursor = { x: event.clientX, y: event.clientY }
    })
    document.addEventListener('pointerdown', function (event) {
      if (!state.menu) return
      var target = event.target
      if (target === state.menu.node.host) return
      if (state.menu.host.contains(target)) return
      closeMenu()
    }, true)
    if (!state.frame) state.frame = requestAnimationFrame(tick)
  }

  mount()
})()
