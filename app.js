"use strict"

const crypto = require("node:crypto")
const http = require("node:http")
const Homey = require("homey")
const { HomeyAPI } = require("homey-api")

const defaultPort = 48555
const appOwnerUri = "homey:app:com.dominicvonk.homeydevicemirror"
const publishActionByDeviceIdCard = "publish_mirror_event_by_id"
const publishActionByDeviceIdCardId = `${appOwnerUri}:${publishActionByDeviceIdCard}`
const serverTokenSetting = "serverToken"
const serverPortSetting = "serverPort"
const serverEnabledSetting = "serverEnabled"
const sourcePollMs = 1000

function jsonResponse(response, statusCode, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(statusCode, {
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json; charset=utf-8",
  })
  response.end(body)
}

function getBearerToken(request) {
  const auth = request.headers.authorization || ""

  if (auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim()
  }

  return String(request.headers["x-homey-mirror-token"] || "").trim()
}

function parseJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    request.on("data", (chunk) => chunks.push(chunk))
    request.on("error", reject)
    request.on("end", () => {
      if (chunks.length === 0) {
        resolve({})
        return
      }

      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")))
      } catch (error) {
        reject(error)
      }
    })
  })
}

function capabilityIdsFor(device) {
  if (Array.isArray(device.capabilities)) {
    return device.capabilities
  }

  return Object.keys(device.capabilitiesObj || {})
}

function compactCapabilityOptions(capability) {
  if (!capability || typeof capability !== "object") {
    return undefined
  }

  const options = {}
  const allowedKeys = [
    "title",
    "desc",
    "type",
    "units",
    "decimals",
    "min",
    "max",
    "step",
    "values",
    "getable",
    "setable",
    "uiComponent",
    "uiQuickAction",
    "zoneActivity",
    "insights",
  ]

  for (const key of allowedKeys) {
    if (capability[key] !== undefined) {
      options[key] = capability[key]
    }
  }

  return Object.keys(options).length > 0 ? options : undefined
}

function serializeDevice(device) {
  const capabilities = capabilityIdsFor(device)
  const capabilitiesOptions = {}
  const state = {}

  for (const capabilityId of capabilities) {
    const capability = device.capabilitiesObj?.[capabilityId]
    const options = compactCapabilityOptions(capability)

    if (options) {
      capabilitiesOptions[capabilityId] = options
    }

    if (capability && Object.hasOwn(capability, "value")) {
      state[capabilityId] = capability.value
    }
  }

  return {
    id: device.id,
    name: device.name,
    class: device.class || "other",
    capabilities,
    capabilitiesOptions,
    state,
    available: Boolean(device.available),
    unavailableMessage: device.unavailableMessage || null,
    warningMessage: device.warningMessage || null,
    energy: device.energy || device.energyObj || null,
    icon: device.icon || null,
    iconObj: device.iconObj || null,
    ownerUri: device.ownerUri || null,
    driverId: device.driverId || null,
    zone: device.zone || null,
    ui: device.ui || null,
  }
}

function extractFlowDeviceId(device) {
  if (!device) {
    return ""
  }

  if (typeof device.id === "string") {
    return device.id
  }

  if (typeof device.getData === "function") {
    const data = device.getData()

    if (typeof data?.id === "string") {
      return data.id
    }
  }

  return ""
}

function parseFlowPayload(value) {
  const text = String(value || "").trim()

  if (!text) {
    return null
  }

  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function localIpFromHomeyLocalUrl(value) {
  try {
    const hostname = new URL(value).hostname
    const homeyLocalIp = hostname.match(
      /^(\d{1,3})-(\d{1,3})-(\d{1,3})-(\d{1,3})\.homey\.homeylocal\.com$/i
    )

    if (homeyLocalIp) {
      return homeyLocalIp.slice(1).join(".")
    }

    return hostname
  } catch {
    return ""
  }
}

function normalizeTokens(tokens) {
  if (!tokens) {
    return []
  }

  if (Array.isArray(tokens)) {
    return tokens
  }

  return Object.entries(tokens).map(([id, token]) => ({
    id,
    ...token,
  }))
}

function requiredArgsForFlowCard(card) {
  return (card.args || []).filter((arg) => arg.required !== false)
}

function flowEventName(card) {
  return String(card.id || "")
    .split(":")
    .filter(Boolean)
    .at(-1)
}

function flowEventNameForArgs(card, args) {
  const baseName = flowEventName(card)
  const suffix = Object.values(args)
    .map((value) => {
      if (value && typeof value === "object") {
        return value.id || value.name || value.value || ""
      }

      return value
    })
    .filter((value) => value !== "")
    .map((value) =>
      String(value)
        .trim()
        .replace(/[^A-Za-z0-9._-]+/g, "_")
        .replace(/^_+|_+$/g, "")
    )
    .filter(Boolean)
    .join(".")

  return suffix ? `${baseName}.${suffix}` : baseName
}

function flowEventPayload(card, cardInstanceId, args) {
  const tokens = {}

  for (const token of normalizeTokens(card.tokens)) {
    if (token?.id) {
      tokens[token.id] = `[[trigger::${cardInstanceId}::${token.id}]]`
    }
  }

  return JSON.stringify({
    args,
    sourceTriggerId: card.id,
    sourceTriggerTitle: card.title || flowEventName(card),
    tokens,
  })
}

function normalizeFlowArgValue(value) {
  if (!value || typeof value !== "object") {
    return value
  }

  if (Object.hasOwn(value, "id")) {
    return value.id
  }

  if (Object.hasOwn(value, "value")) {
    return value.value
  }

  return value
}

function valuesForFlowArg(arg) {
  if (Array.isArray(arg.values) && arg.values.length > 0) {
    return arg.values.map(normalizeFlowArgValue)
  }

  if (arg.type === "boolean" || arg.type === "checkbox") {
    return [true, false]
  }

  return []
}

function expandFlowCardArgStates(card) {
  const requiredArgs = requiredArgsForFlowCard(card)

  if (requiredArgs.length === 0) {
    return {
      states: [{}],
      skipped: null,
    }
  }

  const valueSets = []

  for (const arg of requiredArgs) {
    const values = valuesForFlowArg(arg)

    if (values.length === 0) {
      return {
        states: [],
        skipped: {
          id: card.id,
          title: card.title || flowEventName(card),
          reason: `argument ${arg.name || "unknown"} has no enumerable values`,
        },
      }
    }

    valueSets.push({
      name: arg.name,
      values,
    })
  }

  const states = [{}]

  for (const valueSet of valueSets) {
    const nextStates = []

    for (const state of states) {
      for (const value of valueSet.values) {
        nextStates.push({
          ...state,
          [valueSet.name]: value,
        })
      }
    }

    if (nextStates.length > 128) {
      return {
        states: [],
        skipped: {
          id: card.id,
          title: card.title || flowEventName(card),
          reason: "too many argument combinations",
        },
      }
    }

    states.splice(0, states.length, ...nextStates)
  }

  return {
    states,
    skipped: null,
  }
}

module.exports = class HomeyDeviceMirrorApp extends Homey.App {
  async onInit() {
    this.homeyApi = await HomeyAPI.createAppAPI({ homey: this.homey })
    this.eventClients = new Set()
    await this.ensureServerSettings()
    this.registerFlowCards()

    this.homey.settings.on("set", async (key) => {
      if (
        key === serverPortSetting ||
        key === serverEnabledSetting ||
        key === serverTokenSetting
      ) {
        await this.restartServer().catch(this.error)
      }
    })

    await this.restartServer()
    this.log("Homey Device Mirror initialized")
  }

  registerFlowCards() {
    const registerPublishAction = (cardId, getSourceDeviceId) => {
      this.homey.flow.getActionCard(cardId).registerRunListener(async (args) => {
        const sourceDeviceId = String(getSourceDeviceId(args) || "").trim()
        const event = String(args.event || "").trim()

        if (!sourceDeviceId) {
          throw new Error("Choose a source device.")
        }

        if (!event) {
          throw new Error("Enter an event name.")
        }

        this.publishMirrorEvent({
          event,
          payload: parseFlowPayload(args.payload),
          sourceDeviceId,
        })
      })
    }

    registerPublishAction("publish_mirror_event", (args) =>
      extractFlowDeviceId(args.source_device)
    )
    registerPublishAction(publishActionByDeviceIdCard, (args) => args.source_device_id)
  }

  async onUninit() {
    await this.stopServer()
    this.stopSourcePolling()
  }

  async ensureServerSettings() {
    if (!this.homey.settings.get(serverTokenSetting)) {
      this.homey.settings.set(
        serverTokenSetting,
        crypto.randomBytes(24).toString("hex")
      )
    }

    if (!this.homey.settings.get(serverPortSetting)) {
      this.homey.settings.set(serverPortSetting, defaultPort)
    }

    if (this.homey.settings.get(serverEnabledSetting) === null) {
      this.homey.settings.set(serverEnabledSetting, true)
    }
  }

  async getServerInfo() {
    const port = Number(this.homey.settings.get(serverPortSetting)) || defaultPort
    const enabled = this.homey.settings.get(serverEnabledSetting) !== false
    const localUrl = await this.homey.api.getLocalUrl().catch(() => "")
    const localIp = localIpFromHomeyLocalUrl(localUrl)

    return {
      enabled,
      localIp,
      localUrl,
      port,
      token: this.homey.settings.get(serverTokenSetting),
      url: localIp ? `http://${localIp}:${port}` : `http://<source-homey-ip>:${port}`,
    }
  }

  async rotateServerToken() {
    const token = crypto.randomBytes(24).toString("hex")
    this.homey.settings.set(serverTokenSetting, token)
    return this.getServerInfo()
  }

  async restartServer() {
    await this.stopServer()

    if (this.homey.settings.get(serverEnabledSetting) === false) {
      this.log("Mirror HTTP server disabled")
      return
    }

    const port = Number(this.homey.settings.get(serverPortSetting)) || defaultPort
    this.server = http.createServer(this.handleRequest.bind(this))

    await new Promise((resolve, reject) => {
      this.server.once("error", reject)
      this.server.listen(port, "0.0.0.0", () => {
        this.server.off("error", reject)
        resolve()
      })
    })

    this.log(`Mirror HTTP server listening on ${port}`)
  }

  async stopServer() {
    if (!this.server) {
      return
    }

    const server = this.server
    this.server = null

    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
  }

  async handleRequest(request, response) {
    try {
      const url = new URL(request.url, "http://homey-device-mirror.local")

      if (request.method === "GET" && url.pathname === "/health") {
        jsonResponse(response, 200, {
          ok: true,
          app: "homey-device-mirror",
        })
        return
      }

      if (getBearerToken(request) !== this.homey.settings.get(serverTokenSetting)) {
        jsonResponse(response, 401, { error: "Unauthorized" })
        return
      }

      if (request.method === "GET" && url.pathname === "/devices") {
        const devices = await this.listSourceDevices()
        jsonResponse(response, 200, { devices })
        return
      }

      const matchDevice = url.pathname.match(/^\/devices\/([^/]+)$/)
      if (request.method === "GET" && matchDevice) {
        const device = await this.getSourceDevice(decodeURIComponent(matchDevice[1]))
        jsonResponse(response, 200, { device })
        return
      }

      if (request.method === "GET" && url.pathname === "/events") {
        await this.handleEventsRequest(request, response, url)
        return
      }

      if (request.method === "POST" && url.pathname === "/flows/advanced-link-all") {
        const body = await parseJsonBody(request)
        const result = await this.createOrUpdateForwardAllAdvancedFlow(body.deviceId)
        jsonResponse(response, 200, result)
        return
      }

      const matchCapability = url.pathname.match(
        /^\/devices\/([^/]+)\/capabilities\/([^/]+)$/
      )
      if (request.method === "PUT" && matchCapability) {
        const body = await parseJsonBody(request)
        await this.setSourceCapability({
          deviceId: decodeURIComponent(matchCapability[1]),
          capabilityId: decodeURIComponent(matchCapability[2]),
          value: body.value,
          opts: body.opts || {},
        })
        jsonResponse(response, 200, { ok: true })
        return
      }

      jsonResponse(response, 404, { error: "Not found" })
    } catch (error) {
      this.error(error)
      jsonResponse(response, 500, {
        error: error instanceof Error ? error.message : "Request failed",
      })
    }
  }

  async listSourceDevices() {
    const devices = await this.homeyApi.devices.getDevices()

    return Object.values(devices)
      .filter((device) => device.ownerUri !== appOwnerUri)
      .map(serializeDevice)
      .sort((left, right) => left.name.localeCompare(right.name))
  }

  async getSourceDevice(deviceId) {
    const devices = await this.homeyApi.devices.getDevices()
    const device = devices[deviceId]

    if (!device) {
      throw new Error(`Source device not found: ${deviceId}`)
    }

    return serializeDevice(device)
  }

  async setSourceCapability({ deviceId, capabilityId, value, opts }) {
    const devices = await this.homeyApi.devices.getDevices()
    const device = devices[deviceId]

    if (!device) {
      throw new Error(`Source device not found: ${deviceId}`)
    }

    await device.setCapabilityValue({
      capabilityId,
      opts,
      value,
    })
  }

  async handleEventsRequest(request, response, url) {
    const deviceId = url.searchParams.get("deviceId")

    if (!deviceId) {
      jsonResponse(response, 400, { error: "deviceId is required" })
      return
    }

    response.writeHead(200, {
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
    })
    response.write(": connected\n\n")

    const client = {
      deviceId,
      capabilityInstances: [],
      response,
      lastSnapshot: null,
      lastState: {},
    }

    const close = () => {
      for (const instance of client.capabilityInstances) {
        instance.destroy()
      }

      client.capabilityInstances = []
      this.eventClients.delete(client)
      this.stopSourcePollingIfIdle()
    }

    request.on("close", close)
    response.on("error", close)
    this.eventClients.add(client)
    this.startSourcePolling()

    try {
      const device = await this.getSourceDevice(deviceId)
      this.sendSourceEvent(client, "device.snapshot", { device })
      client.lastSnapshot = JSON.stringify(device)
      client.lastState = { ...device.state }
      await this.attachCapabilityEventListeners(client)
    } catch (error) {
      this.sendSourceEvent(client, "error", {
        message: error instanceof Error ? error.message : "Device event setup failed",
      })
    }
  }

  sendSourceEvent(client, event, data) {
    if (client.response.writableEnded) {
      return
    }

    client.response.write(`event: ${event}\n`)
    client.response.write(`data: ${JSON.stringify(data)}\n\n`)
  }

  publishMirrorEvent({ sourceDeviceId, event, payload }) {
    let delivered = 0
    const data = {
      event,
      payload,
      sourceDeviceId,
    }

    for (const client of this.eventClients) {
      if (client.deviceId === sourceDeviceId) {
        this.sendSourceEvent(client, "flow.event", data)
        delivered += 1
      }
    }

    this.log(
      `Published mirror event ${event} for ${sourceDeviceId} to ${delivered} client(s)`
    )
  }

  async createOrUpdateForwardAllAdvancedFlow(deviceId) {
    const devices = await this.homeyApi.devices.getDevices()
    const device = devices[deviceId]

    if (!device) {
      throw new Error(`Source device not found: ${deviceId}`)
    }

    const triggerCards = Object.values(
      await this.homeyApi.flow.getFlowCardTriggers()
    )
      .filter((card) => card.ownerUri === `homey:device:${deviceId}`)
      .sort((left, right) =>
        String(left.title || left.id).localeCompare(String(right.title || right.id))
      )

    const skipped = []
    const cards = {}
    let row = 0

    for (const triggerCard of triggerCards) {
      const expanded = expandFlowCardArgStates(triggerCard)

      if (expanded.skipped) {
        skipped.push(expanded.skipped)
        continue
      }

      for (const args of expanded.states) {
        const triggerId = crypto.randomUUID()
        const actionId = crypto.randomUUID()
        const y = row * 120
        const event = flowEventNameForArgs(triggerCard, args)

        cards[triggerId] = {
          ownerUri: triggerCard.ownerUri,
          id: triggerCard.id,
          type: "trigger",
          x: 0,
          y,
          args,
          outputSuccess: [actionId],
        }
        cards[actionId] = {
          ownerUri: appOwnerUri,
          id: publishActionByDeviceIdCardId,
          type: "action",
          x: 320,
          y,
          args: {
            source_device_id: device.id,
            event,
            payload: flowEventPayload(triggerCard, triggerId, args),
          },
        }
        row += 1
      }
    }

    if (Object.keys(cards).length === 0) {
      return {
        created: false,
        updated: false,
        flowId: null,
        linkedTriggers: 0,
        skipped,
      }
    }

    const name = `[Mirror] Forward all: ${device.name}`
    const advancedflow = {
      name,
      enabled: true,
      triggerable: false,
      cards,
    }
    const existing = Object.values(await this.homeyApi.flow.getAdvancedFlows()).find(
      (flow) => flow.name === name
    )

    if (existing) {
      const updated = await this.homeyApi.flow.updateAdvancedFlow({
        id: existing.id,
        advancedflow,
      })

      return {
        created: false,
        updated: true,
        flowId: updated.id,
        linkedTriggers: row,
        skipped,
      }
    }

    const created = await this.homeyApi.flow.createAdvancedFlow({ advancedflow })

    return {
      created: true,
      updated: false,
      flowId: created.id,
      linkedTriggers: row,
      skipped,
    }
  }

  async attachCapabilityEventListeners(client) {
    const devices = await this.homeyApi.devices.getDevices()
    const device = devices[client.deviceId]

    if (!device) {
      throw new Error(`Source device not found: ${client.deviceId}`)
    }

    for (const capabilityId of capabilityIdsFor(device)) {
      const instance = device.makeCapabilityInstance(capabilityId, (value) => {
        this.sendSourceEvent(client, "capability.changed", {
          capabilityId,
          value,
        })
      })
      client.capabilityInstances.push(instance)
    }
  }

  startSourcePolling() {
    if (this.sourcePollInterval) {
      return
    }

    this.sourcePollInterval = this.homey.setInterval(() => {
      this.pollSourceEvents().catch(this.error)
    }, sourcePollMs)
  }

  stopSourcePollingIfIdle() {
    if (this.eventClients.size === 0) {
      this.stopSourcePolling()
    }
  }

  stopSourcePolling() {
    if (!this.sourcePollInterval) {
      return
    }

    this.homey.clearInterval(this.sourcePollInterval)
    this.sourcePollInterval = null
  }

  async pollSourceEvents() {
    if (this.eventClients.size === 0) {
      this.stopSourcePolling()
      return
    }

    const rawDevices = await this.homeyApi.devices.getDevices()
    const devices = new Map(
      Object.values(rawDevices).map((device) => [device.id, serializeDevice(device)])
    )

    for (const client of [...this.eventClients]) {
      const device = devices.get(client.deviceId)

      if (!device) {
        this.sendSourceEvent(client, "device.deleted", { deviceId: client.deviceId })
        client.response.end()
        this.eventClients.delete(client)
        continue
      }

      const snapshot = JSON.stringify(device)

      if (snapshot !== client.lastSnapshot) {
        const previousState = client.lastState || {}
        for (const [capabilityId, value] of Object.entries(device.state)) {
          if (previousState[capabilityId] !== value) {
            this.sendSourceEvent(client, "capability.changed", {
              capabilityId,
              value,
            })
          }
        }

        this.sendSourceEvent(client, "device.snapshot", { device })
        client.lastSnapshot = snapshot
        client.lastState = { ...device.state }
      }
    }

    this.stopSourcePollingIfIdle()
  }
}
