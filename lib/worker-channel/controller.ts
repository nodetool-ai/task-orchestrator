/** Public control-plane entrypoint for the worker WebSocket connection manager. */
export {
  connectRun,
  disconnectRun,
  getConnection,
  reconnectActiveChannels,
  sendCommand,
  shutdownAll,
} from "./registry";
export { ControllerConnection, ControllerProtocolError } from "./connection";
