# Homey Device Mirror

Homey Device Mirror lets one Homey expose its devices over a small local HTTP server and lets another Homey add mirrored devices from that source.

Install the same app on both Homeys:

1. On the source Homey, open the app settings and copy the local server URL and token.
2. On the target Homey, add a **Mirrored Device**, paste the source URL and token, then select the device to mirror.
3. The mirrored device opens an HTTP event stream to the source Homey, keeps capabilities in sync, and forwards target-side capability changes back to the source.
4. The target asks the source app to create one **[Mirror] Forward all** Advanced Flow for the selected real device. The generated flow wires every source-device trigger card, including enumerable state/argument combinations, to the **Publish a mirror event** action.

## Scope

- Mirrors device name, class, availability, energy metadata, capabilities, capability options, and current capability values.
- Forwards target-side capability writes to the source Homey through the Homey Web API.
- Streams source-side capability events to the target over a target-initiated HTTP Server-Sent Events request.
- Emits a generic Homey Flow trigger on the target for every source event the bridge receives, with an event argument so remote flows can match generated source events such as `received.1` and `received.0`.
- Adds a source-side Flow action card so any source Flow can explicitly publish device-scoped mirror events to targets.
- Creates or updates one source-side Advanced Flow that forwards all enumerable trigger states for the mirrored source device.
- Uses a shared bearer token for the local HTTP bridge.
- Runs locally on Homey Pro / Homey Self-Hosted. Homey Cloud does not allow app Web APIs with the required full Homey API permission.

Unknown custom capabilities from third-party apps are passed through with their capability options when Homey accepts them. If Homey rejects a custom capability that is not defined by this app, mirror that source device with system capabilities only or add the custom capability definition to the app.

The source Homey streams Homey Web API device capability events and periodic full-device snapshots. The generated Advanced Flow forwards trigger cards exposed by the source device. Trigger cards with open-ended required arguments, such as free-text inputs without predefined values, are skipped because Homey needs a concrete value.

## Development

```sh
npm install
npm run lint
npm run validate
```

Install for testing with:

```sh
npx homey app run
```
