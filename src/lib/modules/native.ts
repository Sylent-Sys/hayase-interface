import SUPPORTS from './settings/supports'

import type { AuthResponse, Native, TorrentFile, TorrentInfo } from 'native'

import { sleep } from '$lib/utils'

const rnd = (range = 100) => Math.floor(Math.random() * range)

/**
 * Extracts a hex infoHash string from a torrent argument.
 * Handles magnet URIs, raw 40-char hex strings, and .torrent file bytes.
 */
async function extractInfoHash (torrent: string | ArrayBufferView): Promise<string> {
  if (typeof torrent === 'string') {
    const magnetMatch = torrent.match(/urn:btih:([a-fA-F0-9]{40}|[A-Z2-7]{32})/i)
    if (magnetMatch) return magnetMatch[1].toLowerCase()
    if (/^[a-fA-F0-9]{40}$/.test(torrent)) return torrent.toLowerCase()
    return torrent
  }
  const parseTorrent = (await import('parse-torrent')).default
  const parsed = await (parseTorrent as (buf: Uint8Array) => Promise<{ infoHash: string }>)(torrent as unknown as Uint8Array)
  return parsed.infoHash
}

let activeHash = ''

/**
 * Calls the backend WebTorrent service and returns TorrentFile[] for the
 * Svelte video player. Video is served via range-request-capable
 * /api/stream/:hash/:fileId endpoints on the backend.
 */
async function fetchTorrentFiles (torrent: string | ArrayBufferView): Promise<TorrentFile[]> {
  const hash = await extractInfoHash(torrent)
  activeHash = hash
  let url = `/api/torrent/${hash}`

  // If we have a full magnet link (from extensions), pass it as a query param
  // so the backend can use the specific trackers found by the extension.
  if (typeof torrent === 'string' && torrent.startsWith('magnet:?')) {
    url += `?magnet=${encodeURIComponent(torrent)}`
  }

  const res = await fetch(url)
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Backend torrent error ${res.status}: ${body}`)
  }
  return res.json() as Promise<TorrentFile[]>
}

function makeAuth<T> (popup: Window | null, callback: (data: { hash: string, search: string }) => T | undefined) {
  return new Promise<T>((resolve, reject) => {
    if (!popup) return reject(new Error('Failed to open popup'))
    const destroy = (err: Error) => {
      channel.close()
      clearTimeout(timeout)
      reject(err)
      popup.close()
    }
    const timeout = setTimeout(() => destroy(new Error('Authentication timed out')), 5 * 60 * 1000) // 5 minutes
    const channel = new BroadcastChannel('hayase-auth')
    channel.onmessage = ({ data }) => {
      const res = callback(data)
      if (!res) return
      resolve(res)
      destroy(new Error('Authentication succeeded'))
    }
  })
}

export default Object.assign<Native, Partial<Native>>({
  authAL: (url: string) => {
    return makeAuth(
      open(url, 'authframe', SUPPORTS.isAndroid ? 'popup' : 'popup,width=382,height=582'),
      ({ hash }) => {
        if (hash.startsWith('#access_token=')) {
          return Object.fromEntries(new URLSearchParams(hash.replace('#', '?')).entries()) as unknown as AuthResponse
        }
      }
    )
  },
  authMAL: (url: string) => {
    return makeAuth(
      open(url, 'authframe', SUPPORTS.isAndroid ? 'popup' : 'popup,width=382,height=582'),
      ({ search }) => {
        if (search.startsWith('?code=')) {
          return Object.fromEntries(new URLSearchParams(search).entries()) as unknown as { code: string, state: string }
        }
      }
    )
  },
  restart: async () => location.reload(),
  openURL: async (url: string) => { open(url) },
  selectPlayer: async () => 'mpv',
  selectDownload: async () => '/tmp/webtorrent',
  share: (...args) => navigator.share(...args),
  setAngle: async () => undefined,
  getLogs: async () => '',
  getDeviceInfo: async () => {
    try {
      const res = await fetch('/api/device/info')
      if (!res.ok) return {}
      return await res.json()
    } catch {
      return {}
    }
  },

  openUIDevtools: async () => undefined,
  openTorrentDevtools: async () => undefined,
  minimise: async () => undefined,
  maximise: async () => undefined,
  focus: async () => undefined,
  close: async () => undefined,
  checkUpdate: async () => undefined,
  updateAndRestart: async () => undefined,
  updateReady: () => sleep(rnd(10_000)),
  toggleDiscordDetails: async () => undefined,
  unsafeUseInternalALAPI: async () => undefined,
  setMediaSession: async (metadata) => { navigator.mediaSession.metadata = new MediaMetadata({ title: metadata.title, artist: metadata.description, artwork: [{ src: metadata.image }] }) },
  setPositionState: async e => navigator.mediaSession.setPositionState(e),
  setPlayBackState: async e => { navigator.mediaSession.playbackState = e },
  setActionHandler: async (...args) => navigator.mediaSession.setActionHandler(...args as [action: MediaSessionAction, handler: MediaSessionActionHandler | null]),
  checkAvailableSpace: () => new Promise(resolve => setTimeout(() => resolve(Math.floor(Math.random() * (1e10 - 1e8 + 1) + 1e8)), 1000)),
  checkIncomingConnections: () => new Promise(resolve => setTimeout(() => resolve(false), 1000)),
  updatePeerCounts: async () => [],

  isApp: false,
  playTorrent: (torrent: string | ArrayBufferView) => fetchTorrentFiles(torrent),
  rescanTorrents: async () => undefined,
  deleteTorrents: async () => undefined,
  library: async () => [],
  attachments: async (hash, fileId) => {
    try {
      const res = await fetch(`/api/attachments/${hash}/${fileId}`)
      if (!res.ok) return []
      return await res.json()
    } catch {
      return []
    }
  },
  tracks: async (hash, fileId) => {
    try {
      const res = await fetch(`/api/tracks/${hash}/${fileId}`)
      if (!res.ok) return []
      return await res.json()
    } catch {
      return []
    }
  },
  subtitles: async (hash, fileId, cb) => {
    try {
      const res = await fetch(`/api/subtitles/${hash}/${fileId}`)
      if (!res.ok) return
      const data = await res.json() as { sub: any, track: number }[]
      for (const { sub, track } of data) {
        cb(sub, track)
      }
    } catch (err) {
      console.error('Failed to fetch subtitles:', err)
    }
  },
  chapters: async () => [
    { start: 5 * 1000, end: 15 * 1000, text: 'OP' },
    { start: 1.0 * 60 * 1000, end: 1.2 * 60 * 1000, text: 'Chapter 1' },
    { start: 1.4 * 60 * 1000, end: 88 * 1000, text: 'Chapter 2 ' }
  ],
  version: async () => {
    try {
      const res = await fetch('/api/version')
      if (!res.ok) return 'v6.4.4'
      const data = await res.json()
      return data.version
    } catch {
      return 'v6.4.4'
    }
  },

  updateSettings: async () => undefined,
  setDOH: async () => undefined,
  cachedTorrents: async () => [],
  spawnPlayer: async () => undefined,
  setHideToTray: async () => undefined,
  setExperimentalGPU: async () => undefined,
  transparency: async () => undefined,
  setZoom: async () => undefined,
  navigate: async () => undefined,
  downloadProgress: async () => undefined,
  updateProgress: async () => undefined,
  createNZB: async () => undefined,
  getDisplays: async (cb) => cb([{ friendlyName: 'Display 1', host: 'display1' }]),
  castPlay: async () => undefined,
  castClose: async () => undefined,
  enableCORS: async () => undefined,
  torrentInfo: async (): Promise<TorrentInfo> => {
    if (!activeHash) {
      return {
        name: '',
        progress: 0,
        size: { total: 0, downloaded: 0, uploaded: 0 },
        speed: { down: 0, up: 0 },
        time: { remaining: 0, elapsed: 0 },
        peers: { seeders: 0, leechers: 0, wires: 0 },
        pieces: { total: 0, size: 0 },
        hash: ''
      }
    }
    try {
      const res = await fetch(`/api/torrent/${activeHash}/status`)
      if (!res.ok) throw new Error('Status fetch failed')
      return await res.json() as TorrentInfo
    } catch (err) {
      console.error('Failed to fetch torrent stats:', err)
      return {
        name: '',
        progress: 0,
        size: { total: 0, downloaded: 0, uploaded: 0 },
        speed: { down: 0, up: 0 },
        time: { remaining: 0, elapsed: 0 },
        peers: { seeders: 0, leechers: 0, wires: 0 },
        pieces: { total: 0, size: 0 },
        hash: activeHash
      }
    }
  },
  fileInfo: async () => [],
  peerInfo: async () => [],
  protocolStatus: async () => {
    try {
      const res = await fetch('/api/protocol/status')
      if (!res.ok) throw new Error()
      return await res.json()
    } catch {
      return {
        dht: false,
        lsd: false,
        pex: false,
        nat: false,
        forwarding: false,
        persisting: false,
        streaming: false
      }
    }
  },

  defaultTransparency: () => false,
  errors: async () => undefined,
  debug: async () => undefined,
  profile: async () => undefined,
  updateToNewEndpoint: async () => undefined
  // @ts-expect-error idk
}, globalThis.native as Partial<Native>)
