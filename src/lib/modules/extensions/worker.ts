import { finalizer } from 'abslink'
import { expose } from 'abslink/w3c'

import type { NZBorURLSource, SearchFunction, SearchOptions, TorrentQuery, TorrentSource } from './types'

const _originalFetch = self.fetch;
const proxiedFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  let url = typeof input === 'string' ? input : (input instanceof Request ? input.url : input.href)
  if (url.startsWith('http') && !url.includes('/api/proxy') && !url.includes(location.origin)) {
    url = '/api/proxy?url=' + encodeURIComponent(url)
  }
  return _originalFetch(url, init)
}

// Override global fetch in the worker so extension scripts using fetch() directly are intercepted
self.fetch = proxiedFetch;

export default expose({
  mod: null as unknown as Promise<(TorrentSource | NZBorURLSource) & { url: string }>,
  construct (code: string) {
    this.mod = this.load(code)
  },

  async load (code: string): Promise<(TorrentSource | NZBorURLSource) & { url: string }> {
    // WARN: unsafe eval
    const url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }))
    const module = await import(/* @vite-ignore */url)
    URL.revokeObjectURL(url)
    return module.default
  },

  async loaded () {
    await this.mod
  },

  [finalizer] () {
    console.log('destroyed worker', self.name)
    self.close()
  },

  async url () {
    return (await this.mod).url
  },

  async single (query: TorrentQuery, options?: SearchOptions): ReturnType<SearchFunction> {
    const queryWithFetch = { ...query, fetch: proxiedFetch }
    return await ((await this.mod) as TorrentSource).single(queryWithFetch, options)
  },

  async batch (query: TorrentQuery, options?: SearchOptions): ReturnType<SearchFunction> {
    const queryWithFetch = { ...query, fetch: proxiedFetch }
    return await ((await this.mod) as TorrentSource).batch(queryWithFetch, options)
  },

  async movie (query: TorrentQuery, options?: SearchOptions): ReturnType<SearchFunction> {
    const queryWithFetch = { ...query, fetch: proxiedFetch }
    return await ((await this.mod) as TorrentSource).movie(queryWithFetch, options)
  },

  async query (hash: string, options?: SearchOptions) {
    return await ((await this.mod) as NZBorURLSource).query(hash, options, proxiedFetch)
  },

  async test () {
    return await (await this.mod).test()
  }
})
