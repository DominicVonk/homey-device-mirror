"use strict"

module.exports = {
  async getServerInfo({ homey }) {
    return homey.app.getServerInfo()
  },

  async rotateServerToken({ homey }) {
    return homey.app.rotateServerToken()
  },
}
