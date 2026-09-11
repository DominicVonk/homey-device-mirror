"use strict"

const Homey = require("homey")
const { isDeepStrictEqual } = require("node:util")
const { openEventStream, requestJson } = require("../../lib/http-json")

const pollIntervalMs = 30000
const reconnectMinMs = 2000
const reconnectMaxMs = 60000

module.exports = class MirrorDevice extends Homey.Device {
  async onInit() {
    this.store = this.getStore()
    this.reconnectDelay = reconnectMinMs
    this.capabilityListeners = new Set()
    this.updateQueue = Promise.resolve()
    await this.startConnection()
    this.log(`Mirroring source device ${this.store.sourceDeviceId}`)
  }

  async startConnection() {
    this.stopped = false
    this.sourceFlowReady = false
    this.registerCapabilityWriteListeners()
    try {
      await this.syncFromSource()
    } catch (error) {
      this.error(error)
      await this.setUnavailable(error.message)
    }
    if (this.stopped) return
    this.startPolling()
    this.startEventStream()
  }

  async updateConnection({ baseUrl, token }) {
    this.stopConnection()
    await this.updateQueue
    try {
      await this.setStoreValue("sourceBaseUrl", baseUrl)
      await this.setStoreValue("sourceToken", token)
      await this.setSettings({ sourceBaseUrl: baseUrl })
    } finally {
      this.store = this.getStore()
      this.reconnectDelay = reconnectMinMs
      await this.startConnection()
    }
  }

  stopConnection() {
    this.stopped = true
    this.stopPolling()
    this.stopEventStream()
  }

  async onDeleted() {
    this.stopConnection()
    await this.updateQueue
  }

  async onUninit() {
    this.stopConnection()
    await this.updateQueue
  }

  enqueueSourceUpdate(update) {
    const result = this.updateQueue.then(() => {
      if (!this.stopped) return update()
    })
    this.updateQueue = result.catch(() => {}) // Keep later updates running; caller handles errors.
    return result
  }

  async onRenamed(name) {
    this.log(`Renamed mirror to ${name}`)
  }

  startPolling() {
    this.stopPolling()
    this.pollInterval = this.homey.setInterval(() => {
      if (this.pollInProgress) return
      this.pollInProgress = true
      this.syncFromSource()
        .catch((error) => {
          this.error(error)
          if (!this.stopped) this.setUnavailable(error.message).catch(this.error)
        })
        .finally(() => {
          this.pollInProgress = false
        })
    }, pollIntervalMs)
  }

  stopPolling() {
    if (this.pollInterval) {
      this.homey.clearInterval(this.pollInterval)
      this.pollInterval = null
    }
  }

  startEventStream() {
    this.stopEventStream()
    if (this.stopped) return
    const path = `/events?deviceId=${encodeURIComponent(this.store.sourceDeviceId)}`

    this.closeEventStream = openEventStream({
      baseUrl: this.store.sourceBaseUrl,
      path,
      token: this.store.sourceToken,
      onEvent: (event, payload) => this.handleSourceEvent(event, payload),
      onError: (error) => this.handleEventStreamError(error),
    })
  }

  stopEventStream() {
    if (this.closeEventStream) {
      this.closeEventStream()
      this.closeEventStream = null
    }

    if (this.reconnectTimer) {
      this.homey.clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  handleEventStreamError(error) {
    if (this.stopped) return
    this.error(error)

    if (this.reconnectTimer) {
      return
    }

    const delay = this.reconnectDelay
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, reconnectMaxMs)
    this.reconnectTimer = this.homey.setTimeout(() => {
      this.reconnectTimer = null
      this.startEventStream()
    }, delay)
  }

  handleSourceEvent(event, payload) {
    return this.enqueueSourceUpdate(() => this.applySourceEvent(event, payload))
  }

  async applySourceEvent(event, payload) {
    this.reconnectDelay = reconnectMinMs

    if (event === "flow.event" && payload?.event) {
      this.driver.triggerSourceEvent(this, payload.event, payload.payload)
      return
    }

    this.driver.triggerSourceEvent(this, event, payload)

    if (event === "device.snapshot" && payload?.device) {
      await this.applySourceDevice(payload.device)
      return
    }

    if (event === "capability.changed" && payload?.capabilityId) {
      await this.applyCapabilityValue(payload.capabilityId, payload.value)
      return
    }

    if (event === "device.deleted") {
      await this.setUnavailable("Source device was removed.")
    }
  }

  syncFromSource() {
    return this.enqueueSourceUpdate(async () => {
      const result = await requestJson({
        baseUrl: this.store.sourceBaseUrl,
        path: `/devices/${encodeURIComponent(this.store.sourceDeviceId)}`,
        token: this.store.sourceToken,
      })
      if (this.stopped) return
      await this.applySourceDevice(result.device)
      if (!this.sourceFlowReady) {
        this.sourceFlowReady = await this.ensureSourceAdvancedFlow()
      }
    })
  }

  async ensureSourceAdvancedFlow() {
    try {
      const result = await requestJson({
        baseUrl: this.store.sourceBaseUrl,
        method: "POST",
        path: "/flows/advanced-link-all",
        token: this.store.sourceToken,
        body: {
          deviceId: this.store.sourceDeviceId,
        },
        timeout: 30000,
      })

      this.log(
        `Source Advanced Flow ${result.created ? "created" : "updated"} with ${
          result.linkedTriggers
        } trigger state(s).`
      )

      if (result.skipped?.length) {
        this.log(
          `Skipped ${result.skipped.length} trigger(s) without enumerable states.`
        )
      }
      return true
    } catch (error) {
      this.error("Could not create source Advanced Flow", error)
      return false
    }
  }

  async applySourceDevice(device) {
    if (!device || !Array.isArray(device.capabilities)) {
      throw new Error("Source response did not include a valid device capability list.")
    }

    await this.ensureCapabilities(device)
    if (device.name && device.name !== this.getName()) {
      await this.homey.app.updateMirrorName(this.getData().id, device.name)
    }
    if (device.class && device.class !== this.getClass()) {
      await this.setClass(device.class)
    }
    const energy = device.energy || {}
    if (!isDeepStrictEqual(this.getEnergy() || {}, energy)) {
      await this.setEnergy(energy)
    }

    for (const [capabilityId, value] of Object.entries(device.state || {})) {
      await this.applyCapabilityValue(capabilityId, value)
    }

    if (device.available) {
      await this.setAvailable()
    } else {
      await this.setUnavailable(device.unavailableMessage || "Source unavailable.")
    }
  }

  async ensureCapabilities(device) {
    const existing = new Set(this.getCapabilities())

    const sourceCapabilities = new Set(device.capabilities || [])
    for (const capabilityId of existing) {
      if (!sourceCapabilities.has(capabilityId)) {
        await this.removeCapability(capabilityId)
        this.capabilityListeners.delete(capabilityId)
      }
    }

    for (const capabilityId of sourceCapabilities) {
      if (!existing.has(capabilityId)) {
        await this.addCapability(capabilityId)
        existing.add(capabilityId)
      }
      const options = device.capabilitiesOptions?.[capabilityId] || {}
      if (!isDeepStrictEqual(this.getCapabilityOptions(capabilityId) || {}, options)) {
        await this.setCapabilityOptions(capabilityId, options)
      }
    }

    this.registerCapabilityWriteListeners()
  }

  async applyCapabilityValue(capabilityId, value) {
    if (!this.hasCapability(capabilityId)) {
      return
    }

    await this.setCapabilityValue(capabilityId, value)
  }

  registerCapabilityWriteListeners() {
    for (const capabilityId of this.getCapabilities()) {
      if (this.capabilityListeners.has(capabilityId)) {
        continue
      }

      this.registerCapabilityListener(capabilityId, async (value, opts) => {
        await requestJson({
          baseUrl: this.store.sourceBaseUrl,
          method: "PUT",
          path: `/devices/${encodeURIComponent(
            this.store.sourceDeviceId
          )}/capabilities/${encodeURIComponent(capabilityId)}`,
          token: this.store.sourceToken,
          body: {
            opts,
            value,
          },
        })
      })

      this.capabilityListeners.add(capabilityId)
    }
  }
}
