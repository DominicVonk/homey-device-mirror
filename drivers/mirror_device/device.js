"use strict"

const Homey = require("homey")
const { openEventStream, requestJson } = require("../../lib/http-json")

const pollIntervalMs = 30000
const reconnectMinMs = 2000
const reconnectMaxMs = 60000

module.exports = class MirrorDevice extends Homey.Device {
  async onInit() {
    this.store = this.getStore()
    this.reconnectDelay = reconnectMinMs
    this.capabilityListeners = new Set()
    this.sourceUpdateInProgress = false

    await this.syncFromSource()
    await this.ensureSourceAdvancedFlow()
    this.registerCapabilityWriteListeners()
    this.startPolling()
    this.startEventStream()
    this.log(`Mirroring source device ${this.store.sourceDeviceId}`)
  }

  async onDeleted() {
    this.stopPolling()
    this.stopEventStream()
  }

  async onRenamed(name) {
    this.log(`Renamed mirror to ${name}`)
  }

  startPolling() {
    this.stopPolling()
    this.pollInterval = this.homey.setInterval(() => {
      this.syncFromSource().catch((error) => {
        this.error(error)
        this.setUnavailable(error.message).catch(this.error)
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

  async handleSourceEvent(event, payload) {
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

  async syncFromSource() {
    const result = await requestJson({
      baseUrl: this.store.sourceBaseUrl,
      path: `/devices/${encodeURIComponent(this.store.sourceDeviceId)}`,
      token: this.store.sourceToken,
    })

    await this.applySourceDevice(result.device)
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
    } catch (error) {
      this.error("Could not create source Advanced Flow", error)
    }
  }

  async applySourceDevice(device) {
    if (!device) {
      throw new Error("Source response did not include a device.")
    }

    await this.ensureCapabilities(device)

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

    for (const capabilityId of device.capabilities || []) {
      if (!existing.has(capabilityId)) {
        await this.addCapability(capabilityId)
        existing.add(capabilityId)
      }
    }

    this.registerCapabilityWriteListeners()
  }

  async applyCapabilityValue(capabilityId, value) {
    if (!this.hasCapability(capabilityId)) {
      return
    }

    try {
      this.sourceUpdateInProgress = true
      await this.setCapabilityValue(capabilityId, value)
    } finally {
      this.sourceUpdateInProgress = false
    }
  }

  registerCapabilityWriteListeners() {
    for (const capabilityId of this.getCapabilities()) {
      if (this.capabilityListeners.has(capabilityId)) {
        continue
      }

      this.registerCapabilityListener(capabilityId, async (value, opts) => {
        if (this.sourceUpdateInProgress) {
          return
        }

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
