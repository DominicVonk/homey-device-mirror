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

  const dispatch = () => {
    if (dataLines.length === 0) {
      return
    }

    const rawData = dataLines.join("\n")
    const name = eventName
    eventName = "message"
    dataLines = []

    try {
      onEvent(name, rawData ? JSON.parse(rawData) : null)
    } catch (error) {
      onError(error)
    }
  }

  const request = transport.request(
    url,
    {
      method: "GET",
      headers: {
        accept: "text/event-stream",
        authorization: `Bearer ${token}`,
      },
    },
    (response) => {
      if ((response.statusCode || 0) >= 400) {
        onError(new Error(`Event stream failed with HTTP ${response.statusCode}`))
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
        if (!closed) {
          onError(new Error("Event stream closed"))
        }
      })
    }
  )

  request.on("error", (error) => {
    if (!closed) {
      onError(error)
    }
  })
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
