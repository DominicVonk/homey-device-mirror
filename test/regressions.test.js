"use strict"

const assert = require("node:assert/strict")
const { test } = require("node:test")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")
const http = require("node:http")
const { once } = require("node:events")
const { createRequire } = require("node:module")
const { requestJson, openEventStream } = require("../lib/http-json")

const owner = "homey:app:com.dominicvonk.homeydevicemirror"
const homey = { App: class {}, Device: class {}, Driver: class {} }
function load(file, mocks = {}) {
  const filename = path.resolve(__dirname, "..", file)
  const localRequire = createRequire(filename)
  const module = { exports: {} }
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), {
    module, Buffer, URL,
    require: (id) => id === "homey" ? homey :
      Object.hasOwn(mocks, id) ? mocks[id] : localRequire(id),
  }, { filename })
  return module.exports
}
function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}
async function serve(t, handler) {
  const server = http.createServer(handler)
  const sockets = new Set()
  server.on("connection", (socket) => {
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  t.after(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise((resolve) => server.close(resolve))
  })
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` }
}
function mirror(request = async () => ({ device: snapshot() })) {
  const Device = load("drivers/mirror_device/device.js", {
    "../../lib/http-json": { requestJson: request, openEventStream: () => () => {} },
  })
  const device = new Device()
  const store = { sourceBaseUrl: "http://old", sourceToken: "old", sourceDeviceId: "source" }
  let name = "Light", deviceClass = "light", energy = {}, capabilities = ["onoff"]
  const options = { onoff: {} }, values = {}, listeners = {}
  Object.assign(device, {
    getStore: () => ({ ...store }),
    setStoreValue: async (key, value) => { store[key] = value },
    setSettings: async () => {},
    getData: () => ({ id: "mirror-identity" }),
    getName: () => name,
    getClass: () => deviceClass,
    setClass: async (value) => { deviceClass = value },
    getEnergy: () => energy,
    setEnergy: async (value) => { energy = value },
    getCapabilities: () => [...capabilities],
    hasCapability: (id) => capabilities.includes(id),
    addCapability: async (id) => { capabilities.push(id) },
    removeCapability: async (id) => { capabilities = capabilities.filter((value) => value !== id) },
    getCapabilityOptions: (id) => options[id],
    setCapabilityOptions: async (id, value) => { options[id] = value },
    setCapabilityValue: async (id, value) => { values[id] = value },
    registerCapabilityListener: (id, listener) => { listeners[id] = listener },
    setAvailable: async () => { device.available = true },
    setUnavailable: async () => { device.available = false },
    log: () => {}, error: () => {},
    homey: {
      app: { updateMirrorName: async (id, value) => { name = value } },
      setInterval: (callback) => { device.poll = callback; return 1 },
      clearInterval: () => { device.poll = null },
      setTimeout: (callback) => { device.reconnect = callback; return 2 },
      clearTimeout: () => { device.reconnect = null },
    },
    driver: { triggerSourceEvent: () => {} },
    listeners, values,
    updateQueue: Promise.resolve(), capabilityListeners: new Set(), store,
  })
  return device
}
function snapshot(overrides = {}) {
  return { id: "source", name: "Light", class: "light", available: true,
    capabilities: ["onoff"], capabilitiesOptions: { onoff: {} },
    state: { onoff: false }, energy: {}, ...overrides }
}
function app() {
  const App = load("app.js", { "homey-api": {} })
  const instance = new App()
  Object.assign(instance, {
    eventClients: new Set(), log: () => {}, error: () => {},
    homey: { setInterval: () => 1, clearInterval: () => {} },
  })
  return instance
}

test("offline initialization retains recovery and later sync restores availability", async () => {
  let offline = true, flows = 0
  const device = mirror(async ({ method }) => {
    if (offline) throw new Error("Offline")
    if (method === "POST") { flows++; return { linkedTriggers: 1 } }
    return { device: snapshot() }
  })
  await device.onInit()
  assert.equal(device.available, false)
  assert.equal(typeof device.poll, "function")
  assert.equal(typeof device.closeEventStream, "function")
  offline = false
  await device.syncFromSource()
  assert.equal(device.available, true)
  assert.equal(flows, 1)
  await device.onDeleted()
  assert.equal(device.poll, null)
  device.handleEventStreamError(new Error("Late error"))
  assert.equal(device.reconnect, undefined)
})

test("event trigger only matches the configured event", async () => {
  const Driver = load("drivers/mirror_device/driver.js")
  const driver = new Driver()
  let match
  driver.homey = { flow: { getDeviceTriggerCard: () => ({ registerRunListener: (fn) => { match = fn } }) } }
  driver.log = () => {}
  await driver.onInit()
  assert.equal(match({ event: "received.1" }, { event: "received.1" }), true)
  assert.equal(match({ event: "received.1" }, { event: "received.0" }), false)
})

test("repair validates and persists new credentials without replacing device identity", async () => {
  const requests = []
  const request = async (args) => {
    requests.push(args)
    return args.method === "POST" ? { linkedTriggers: 1 } : { device: snapshot() }
  }
  const device = mirror(request)
  await device.onInit()
  const Driver = load("drivers/mirror_device/driver.js", {
    "../../lib/http-json": { requestJson: request, normalizeBaseUrl: (value) => value.trim() },
  })
  const handlers = {}
  await new Driver().onRepair({ setHandler: (id, fn) => { handlers[id] = fn } }, device)
  requests.length = 0
  await handlers.set_connection({ baseUrl: "http://new", token: "new" })
  assert.equal(requests.length, 3)
  assert.ok(requests.every((args) => args.baseUrl === "http://new" && args.token === "new"))
  assert.equal(requests[0].path, "/devices/source")
  assert.equal(device.getStore().sourceToken, "new")
  assert.equal(device.getStore().sourceDeviceId, "source")
  assert.equal(device.getData().id, "mirror-identity")
  await device.onDeleted()
})

test("repair rejects an unexpected source identity without changing credentials", async () => {
  const device = mirror()
  const Driver = load("drivers/mirror_device/driver.js", {
    "../../lib/http-json": { requestJson: async () => ({ device: { id: "other" } }), normalizeBaseUrl: (value) => value },
  })
  const handlers = {}
  await new Driver().onRepair({ setHandler: (id, fn) => { handlers[id] = fn } }, device)
  await assert.rejects(handlers.set_connection({ baseUrl: "http://new", token: "new" }), /original device/)
  assert.equal(device.getStore().sourceToken, "old")
})

test("server shutdown terminates streams and destroys capability subscriptions", { timeout: 2000 }, async (t) => {
  const instance = app()
  let destroyed = 0
  instance.getSourceDevice = async () => snapshot()
  instance.attachCapabilityEventListeners = async (client) => {
    client.capabilityInstances.push({ destroy: () => { destroyed++ } })
  }
  const { server, baseUrl } = await serve(t, (req, res) => {
    instance.handleEventsRequest(req, res, new URL(req.url, baseUrl)).catch(assert.fail)
  })
  instance.server = server
  const request = http.get(`${baseUrl}/events?deviceId=source`)
  t.after(() => request.destroy())
  const [response] = await once(request, "response")
  response.on("error", () => {})
  response.resume()
  assert.equal(instance.eventClients.size, 1)
  await instance.stopServer()
  assert.equal(instance.eventClients.size, 0)
  assert.equal(destroyed, 1)
})

test("settings restarts are serialized and recover after a failed start", async () => {
  const instance = app()
  const gate = deferred()
  let active = 0, maximum = 0, calls = 0
  instance.startServer = async () => {
    calls++; active++; maximum = Math.max(maximum, active)
    await gate.promise
    active--
    if (calls === 1) throw new Error("Port busy")
  }
  const first = instance.restartServer()
  const second = instance.restartServer()
  const rejected = assert.rejects(first, /Port busy/)
  gate.resolve()
  await rejected
  await second
  assert.equal(maximum, 1)
  assert.equal(calls, 2)
})

test("truncated JSON responses reject instead of hanging", { timeout: 2000 }, async (t) => {
  const { baseUrl } = await serve(t, (req, res) => {
    res.writeHead(200)
    res.write('{"incomplete":')
    setImmediate(() => res.destroy())
  })
  await assert.rejects(requestJson({ baseUrl, path: "/", token: "token" }), /aborted|reset/i)
})

test("aborted event streams signal one reconnect error", { timeout: 2000 }, async (t) => {
  const { baseUrl } = await serve(t, (req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.write(": connected\n\n")
    setImmediate(() => res.destroy())
  })
  const error = deferred()
  let errors = 0
  const close = openEventStream({ baseUrl, path: "/", token: "token", onEvent: () => {},
    onError: (value) => { errors++; error.resolve(value) } })
  t.after(close)
  assert.match((await error.promise).message, /aborted|reset/i)
  await new Promise(setImmediate)
  assert.equal(errors, 1)
})

test("async stream handlers run in order and their failures reach onError", { timeout: 2000 }, async (t) => {
  const { baseUrl } = await serve(t, (req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.write('event: test\ndata: 1\n\nevent: test\ndata: 2\n\n')
  })
  const gate = deferred(), started = deferred(), failed = deferred(), seen = []
  const close = openEventStream({ baseUrl, path: "/", token: "token",
    onEvent: async (event, value) => {
      seen.push(value)
      if (value === 1) { started.resolve(); await gate.promise }
      else throw new Error("Could not apply capability")
    },
    onError: failed.resolve,
  })
  t.after(close)
  await started.promise
  assert.deepEqual(seen, [1])
  gate.resolve()
  assert.match((await failed.promise).message, /Could not apply/)
  assert.deepEqual(seen, [1, 2])
})

test("user writes are forwarded even while a source value is being applied", async () => {
  const writes = []
  const device = mirror(async (args) => { writes.push(args); return {} })
  const gate = deferred()
  device.setCapabilityValue = () => gate.promise
  device.registerCapabilityWriteListeners()
  const applying = device.applyCapabilityValue("onoff", false)
  await device.listeners.onoff(true, {})
  assert.equal(writes.length, 1)
  assert.equal(writes[0].method, "PUT")
  assert.equal(writes[0].body.value, true)
  gate.resolve()
  await applying
})

test("poll snapshots and stream events share a queue that survives failures", async () => {
  const gate = deferred(), requested = deferred()
  const device = mirror(async () => { requested.resolve(); await gate.promise; return { device: snapshot() } })
  device.sourceFlowReady = true
  const applied = []
  device.setCapabilityValue = async (id, value) => { applied.push(value) }
  const sync = device.syncFromSource()
  await requested.promise
  const event = device.handleSourceEvent("capability.changed", { capabilityId: "onoff", value: true })
  gate.resolve()
  await Promise.all([sync, event])
  assert.deepEqual(applied, [false, true])
  await assert.rejects(device.enqueueSourceUpdate(() => { throw new Error("Bad snapshot") }), /Bad snapshot/)
  await device.handleSourceEvent("capability.changed", { capabilityId: "onoff", value: false })
  assert.deepEqual(applied, [false, true, false])
})

test("metadata and capability removals converge without repeated metadata writes", async () => {
  const device = mirror()
  device.registerCapabilityWriteListeners()
  let optionWrites = 0
  const setOptions = device.setCapabilityOptions
  device.setCapabilityOptions = async (...args) => { optionWrites++; await setOptions(...args) }
  const source = snapshot({ name: "Thermostat", class: "thermostat", energy: { batteries: ["AA"] },
    capabilities: ["target_temperature"], capabilitiesOptions: { target_temperature: { min: 5, max: 25 } },
    state: { target_temperature: 20 } })
  await device.applySourceDevice(source)
  await device.applySourceDevice(source)
  assert.equal(device.getName(), "Thermostat")
  assert.equal(device.getClass(), "thermostat")
  assert.deepEqual(device.getEnergy(), { batteries: ["AA"] })
  assert.deepEqual(device.getCapabilities(), ["target_temperature"])
  assert.equal(device.capabilityListeners.has("onoff"), false)
  assert.equal(device.values.target_temperature, 20)
  assert.equal(optionWrites, 1)
})

test("name synchronization identifies only this app's mirror", async () => {
  const instance = app()
  let updated
  instance.homeyApi = { devices: {
    getDevices: async () => ({
      other: { id: "other", data: { id: "same" }, driverId: "another-app:device" },
      mirror: { id: "mirror", data: { id: "same" }, driverId: `${owner}:mirror_device` },
    }),
    updateDevice: async (args) => { updated = args },
  } }
  await instance.updateMirrorName("same", "New name")
  assert.equal(updated.id, "mirror")
  assert.equal(updated.device.name, "New name")
})

function flowApp() {
  const instance = app(), flows = {}, devices = {
    a: { id: "a", name: "Same name" }, b: { id: "b", name: "Same name" },
  }
  let created = 0
  instance.homeyApi = {
    devices: { getDevices: async () => devices },
    flow: {
      getFlowCardTriggers: async () => Object.keys(devices).map((id) => ({
        id: `homey:device:${id}:received`, ownerUri: `homey:device:${id}`, args: [],
      })),
      getAdvancedFlows: async () => flows,
      createAdvancedFlow: async ({ advancedflow }) => {
        const id = String(++created)
        flows[id] = { ...advancedflow, id }
        return flows[id]
      },
      updateAdvancedFlow: async ({ id, advancedflow }) => {
        flows[id] = { ...flows[id], ...advancedflow }
        return flows[id]
      },
    },
  }
  return { instance, flows, devices }
}

test("same-name devices get separate flows and renames reuse source identity", async () => {
  const { instance, flows, devices } = flowApp()
  const first = await instance.createOrUpdateForwardAllAdvancedFlow("a")
  const second = await instance.createOrUpdateForwardAllAdvancedFlow("b")
  assert.notEqual(first.flowId, second.flowId)
  devices.a.name = "Renamed"
  const renamed = await instance.createOrUpdateForwardAllAdvancedFlow("a")
  assert.equal(renamed.flowId, first.flowId)
  assert.equal(Object.keys(flows).length, 2)
  assert.equal(flows[first.flowId].name, "[Mirror] Forward all: Renamed")
})

test("concurrent flow requests create only one flow and disable legacy duplicates", async () => {
  const { instance, flows } = flowApp()
  const [first, second] = await Promise.all([
    instance.createOrUpdateForwardAllAdvancedFlow("a"),
    instance.createOrUpdateForwardAllAdvancedFlow("a"),
  ])
  assert.equal(first.flowId, second.flowId)
  flows.duplicate = { ...flows[first.flowId], id: "duplicate", name: "[Mirror] Forward all: Old name" }
  await instance.createOrUpdateForwardAllAdvancedFlow("a")
  assert.equal(flows.duplicate.enabled, false)
  assert.equal(flows[first.flowId].enabled, true)
})

test("realtime and polling emit only one capability event for the same change", async () => {
  const instance = app()
  let realtime
  const device = { id: "source", name: "Light", available: true,
    capabilities: ["onoff"], capabilitiesObj: { onoff: { value: false } },
    makeCapabilityInstance: (id, fn) => { realtime = fn; return { destroy: () => {} } },
  }
  instance.homeyApi = { devices: { getDevices: async () => ({ source: device }) } }
  const client = { deviceId: "source", lastState: { onoff: false }, capabilityInstances: [], response: { write: () => {} } }
  instance.eventClients.add(client)
  const events = []
  instance.sendSourceEvent = (client, event) => events.push(event)
  await instance.pollSourceEvents()
  events.length = 0
  await instance.attachCapabilityEventListeners(client)
  device.capabilitiesObj.onoff.value = true
  realtime(true)
  await instance.pollSourceEvents()
  realtime(true)
  assert.equal(events.filter((event) => event === "capability.changed").length, 1)
  assert.ok(events.includes("device.snapshot"))
})

test("a closed stream cannot acquire subscriptions after asynchronous setup", async () => {
  const instance = app(), gate = deferred()
  let subscriptions = 0
  instance.homeyApi = { devices: { getDevices: async () => {
    await gate.promise
    return { source: { capabilities: ["onoff"], makeCapabilityInstance: () => { subscriptions++ } } }
  } } }
  const client = { deviceId: "source", closed: false, capabilityInstances: [] }
  const attaching = instance.attachCapabilityEventListeners(client)
  client.closed = true
  gate.resolve()
  await attaching
  assert.equal(subscriptions, 0)
})

test("malformed snapshots cannot remove existing capabilities", async () => {
  const device = mirror()
  await assert.rejects(device.applySourceDevice({ state: {} }), /valid device capability list/)
  assert.deepEqual(device.getCapabilities(), ["onoff"])
})

test("flow generation preserves an unrelated flow with the same name", async () => {
  const { instance, flows } = flowApp()
  const unrelated = { id: "manual", name: "[Mirror] Forward all: Same name", enabled: true,
    cards: { action: { type: "action", id: "another-app:action" } } }
  flows.manual = unrelated
  const generated = await instance.createOrUpdateForwardAllAdvancedFlow("a")
  assert.notEqual(generated.flowId, "manual")
  assert.equal(flows.manual, unrelated)
})

test("a graceful stream end delivers queued events before signaling reconnection", { timeout: 2000 }, async (t) => {
  const { baseUrl } = await serve(t, (req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.end('event: test\ndata: 1\n\nevent: test\ndata: 2\n\n')
  })
  const ended = deferred(), seen = []
  const close = openEventStream({ baseUrl, path: "/", token: "token",
    onEvent: async (event, value) => { await new Promise(setImmediate); seen.push(value) },
    onError: ended.resolve,
  })
  t.after(close)
  assert.match((await ended.promise).message, /closed/)
  assert.deepEqual(seen, [1, 2])
})

test("stalled event connections time out and request reconnection", async () => {
  const request = new (require("node:events").EventEmitter)()
  request.destroy = () => {}
  request.end = () => {}
  let timeout
  const helper = load("lib/http-json.js", {
    "node:http": { request: (url, options) => { timeout = options.timeout; return request } },
  })
  let error
  const close = helper.openEventStream({ baseUrl: "http://source", path: "/", token: "token",
    onEvent: () => {}, onError: (value) => { error = value } })
  assert.equal(timeout, 45000)
  request.emit("timeout")
  assert.match(error.message, /timed out/)
  close()
})
