"use strict"

const Homey = require("homey")
const { requestJson, normalizeBaseUrl } = require("../../lib/http-json")

function cleanConnection(data = {}) {
  return {
    baseUrl: normalizeBaseUrl(data.baseUrl),
    token: String(data.token || "").trim(),
  }
}

module.exports = class MirrorDeviceDriver extends Homey.Driver {
  async onInit() {
    this.eventTrigger = this.homey.flow.getDeviceTriggerCard("mirror_device_event")
    this.log("Mirror device driver initialized")
  }

  async onPair(session) {
    let connection = null

    session.setHandler("set_connection", async (data) => {
      connection = cleanConnection(data)

      if (!connection.baseUrl || !connection.token) {
        throw new Error("Enter the source Homey URL and token.")
      }

      await requestJson({
        baseUrl: connection.baseUrl,
        path: "/devices",
        token: connection.token,
      })

      return true
    })

    session.setHandler("list_devices", async () => {
      if (!connection) {
        throw new Error("Connect to the source Homey first.")
      }

      const result = await requestJson({
        baseUrl: connection.baseUrl,
        path: "/devices",
        token: connection.token,
      })

      return result.devices.map((device) => this.mapSourceDevice(connection, device))
    })
  }

  async onRepair(session, device) {
    await this.onPair(session)
    session.setHandler("list_devices", async () => {
      const store = device.getStore()
      const connection = {
        baseUrl: store.sourceBaseUrl,
        token: store.sourceToken,
      }
      const result = await requestJson({
        baseUrl: connection.baseUrl,
        path: "/devices",
        token: connection.token,
      })

      return result.devices.map((sourceDevice) =>
        this.mapSourceDevice(connection, sourceDevice)
      )
    })
  }

  mapSourceDevice(connection, device) {
    return {
      name: device.name,
      class: device.class || "other",
      data: {
        id: `${connection.baseUrl}:${device.id}`,
      },
      capabilities: device.capabilities,
      capabilitiesOptions: device.capabilitiesOptions,
      energy: device.energy || undefined,
      icon: device.icon || undefined,
      settings: {
        sourceBaseUrl: connection.baseUrl,
        sourceDeviceId: device.id,
      },
      store: {
        sourceBaseUrl: connection.baseUrl,
        sourceDeviceId: device.id,
        sourceToken: connection.token,
      },
    }
  }

  triggerSourceEvent(device, event, payload) {
    this.eventTrigger
      .trigger(
        device,
        {
          event,
          payload: JSON.stringify(payload),
        },
        {
          event,
        }
      )
      .catch(this.error)
  }
}
