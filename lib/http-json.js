"use strict"

const http = require("node:http")
const https = require("node:https")

function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "")
}

function requestJson({ baseUrl, method = "GET", path, token, body, timeout = 15000 }) {
  const url = new URL(`${normalizeBaseUrl(baseUrl)}${path}`)
  const transport = url.protocol === "https:" ? https : http
  const payload = body === undefined ? undefined : JSON.stringify(body)

  return new Promise((resolve, reject) => {
    const request = transport.request(
      url,
      {
        method,
        timeout,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
          ...(payload
            ? {
                "content-length": Buffer.byteLength(payload),
                "content-type": "application/json",
              }
            : {}),
        },
      },
      (response) => {
        const chunks = []
        response.on("error", reject)
        response.on("aborted", () => reject(new Error("Response aborted")))
        response.on("data", (chunk) => chunks.push(chunk))
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8")

          if ((response.statusCode || 0) >= 400) {
            reject(new Error(text || `HTTP ${response.statusCode}`))
            return
          }

          try {
            resolve(text ? JSON.parse(text) : {})
          } catch (error) {
            reject(error)
          }
        })
      }
    )

    request.on("timeout", () => request.destroy(new Error("Request timed out")))
    request.on("error", reject)

    if (payload) {
      request.write(payload)
    }

    request.end()
  })
}

function openEventStream({ baseUrl, path, token, onEvent, onError }) {
  const url = new URL(`${normalizeBaseUrl(baseUrl)}${path}`)
  const transport = url.protocol === "https:" ? https : http
  let closed = false
  let eventName = "message"
  let dataLines = []
  let eventQueue = Promise.resolve()

  const fail = (error) => {
    if (closed) return
    closed = true
    request.destroy()
    onError(error)
  }

  const dispatch = () => {
    if (dataLines.length === 0) {
      return
    }

    const rawData = dataLines.join("\n")
    const name = eventName
    eventName = "message"
    dataLines = []

    eventQueue = eventQueue
      .then(async () => {
        if (!closed) await onEvent(name, JSON.parse(rawData))
      })
      .catch(fail)
  }

  const request = transport.request(
    url,
    {
      method: "GET",
      timeout: 45000,
      headers: {
        accept: "text/event-stream",
        authorization: `Bearer ${token}`,
      },
    },
    (response) => {
      response.on("error", fail)
      response.on("aborted", () => fail(new Error("Event stream aborted")))
      if (response.statusCode !== 200) {
        fail(new Error(`Event stream failed with HTTP ${response.statusCode}`))
        response.resume()
        return
      }

      let buffer = ""
      response.setEncoding("utf8")
      response.on("data", (chunk) => {
        buffer += chunk
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() || ""

        for (const line of lines) {
          if (line === "") {
            dispatch()
          } else if (line.startsWith("event:")) {
            eventName = line.slice(6).trim() || "message"
          } else if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).trimStart())
          }
        }
      })
      response.on("end", () => {
        eventQueue.then(() => fail(new Error("Event stream closed")))
      })
    }
  )

  request.on("timeout", () => fail(new Error("Event stream timed out")))
  request.on("error", fail)
  request.end()

  return () => {
    closed = true
    request.destroy()
  }
}

module.exports = {
  normalizeBaseUrl,
  openEventStream,
  requestJson,
}
