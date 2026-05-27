// `@snowluma/channel-socket` — future pure-socket transport (no
// QQ.exe, no hook). Today an empty stub so `Hub` can register it as a
// `ChannelAdapter` of kind `'socket'` and exercise the adapter pool
// end-to-end. Will materialise a real `SocketChannel` once the
// pure-socket login client lands.

export { SocketChannel } from './socket-channel';
export { SocketAdapter } from './socket-adapter';
