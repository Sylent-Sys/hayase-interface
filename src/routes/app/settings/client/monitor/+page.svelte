<script lang='ts'>
  import { onMount } from 'svelte'

  import { Button } from '$lib/components/ui/button'

  interface ProxyMetrics {
    activeStreams: number
    sessionStreamCountsSize: number
    metadataCacheSize: number
    limits: {
      maxConcurrentStreams: number
      maxConcurrentStreamsPerSession: number
      metadataCacheTtlMs: number
      maxMetadataCacheEntries: number
    }
    sessionStreams: Array<{ sessionId: string, activeStreams: number }>
    updatedAt: string
  }

  let metrics: ProxyMetrics | null = null
  let loading = true
  let error = ''
  let lastUpdated = ''
  let timer: ReturnType<typeof setInterval> | undefined
  let refreshing = false

  async function refreshMetrics () {
    if (refreshing) return
    refreshing = true
    error = ''

    try {
      const res = await fetch('/api/metrics', { cache: 'no-store' })
      if (!res.ok) {
        throw new Error(`Metrics request failed: ${res.status}`)
      }
      metrics = await res.json() as ProxyMetrics
      lastUpdated = new Date(metrics.updatedAt).toLocaleTimeString()
    } catch (err) {
      error = err instanceof Error ? err.message : 'Unknown error'
    } finally {
      loading = false
      refreshing = false
    }
  }

  onMount(() => {
    void refreshMetrics()
    timer = setInterval(() => {
      void refreshMetrics()
    }, 2000)

    return () => {
      if (timer) clearInterval(timer)
    }
  })

  function shortSessionId (sessionId: string) {
    if (sessionId.length <= 10) return sessionId
    return `${sessionId.slice(0, 6)}...${sessionId.slice(-4)}`
  }
</script>

<div class='space-y-4'>
  <div class='flex items-center justify-between flex-wrap gap-3'>
    <div>
      <h3 class='text-xl font-bold'>Client Proxy Monitor</h3>
      <p class='text-sm text-muted-foreground'>
        Real-time metrics from the proxy endpoint (/api/metrics), auto-refresh every 2 seconds.
      </p>
    </div>
    <div class='flex items-center gap-2'>
      <div class='text-xs text-muted-foreground'>Last updated: {lastUpdated || '-'}</div>
      <Button variant='secondary' on:click={refreshMetrics} disabled={refreshing}>
        {refreshing ? 'Refreshing...' : 'Refresh now'}
      </Button>
    </div>
  </div>

  {#if loading}
    <div class='text-sm text-muted-foreground'>Loading metrics...</div>
  {:else if error}
    <div class='rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm'>
      Failed to load metrics: {error}
    </div>
  {/if}

  <div class='grid grid-cols-1 sm:grid-cols-3 gap-3'>
    <div class='rounded-lg border bg-card p-4'>
      <div class='text-xs text-muted-foreground'>Active Streams</div>
      <div class='text-3xl font-bold'>{metrics?.activeStreams ?? 0}</div>
    </div>

    <div class='rounded-lg border bg-card p-4'>
      <div class='text-xs text-muted-foreground'>Session Stream Count Size</div>
      <div class='text-3xl font-bold'>{metrics?.sessionStreamCountsSize ?? 0}</div>
    </div>

    <div class='rounded-lg border bg-card p-4'>
      <div class='text-xs text-muted-foreground'>Metadata Cache Size</div>
      <div class='text-3xl font-bold'>{metrics?.metadataCacheSize ?? 0}</div>
    </div>
  </div>

  <div class='rounded-lg border bg-card p-4 space-y-3'>
    <div class='text-sm font-semibold'>Configured Limits</div>
    <div class='grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 text-sm'>
      <div class='rounded border p-2'>
        <div class='text-xs text-muted-foreground'>Global Stream Limit</div>
        <div class='font-semibold'>{metrics?.limits.maxConcurrentStreams ?? '-'}</div>
      </div>
      <div class='rounded border p-2'>
        <div class='text-xs text-muted-foreground'>Per-Session Stream Limit</div>
        <div class='font-semibold'>{metrics?.limits.maxConcurrentStreamsPerSession ?? '-'}</div>
      </div>
      <div class='rounded border p-2'>
        <div class='text-xs text-muted-foreground'>Metadata Cache TTL (ms)</div>
        <div class='font-semibold'>{metrics?.limits.metadataCacheTtlMs ?? '-'}</div>
      </div>
      <div class='rounded border p-2'>
        <div class='text-xs text-muted-foreground'>Max Metadata Cache Entries</div>
        <div class='font-semibold'>{metrics?.limits.maxMetadataCacheEntries ?? '-'}</div>
      </div>
    </div>
  </div>

  <div class='rounded-lg border bg-card p-4 space-y-3'>
    <div class='text-sm font-semibold'>Session Streams</div>
    {#if (metrics?.sessionStreams.length ?? 0) === 0}
      <div class='text-sm text-muted-foreground'>No active session streams right now.</div>
    {:else}
      <div class='overflow-auto'>
        <table class='w-full text-sm'>
          <thead>
            <tr class='text-left border-b'>
              <th class='py-2 pr-3'>Session</th>
              <th class='py-2 pr-3'>Active Streams</th>
            </tr>
          </thead>
          <tbody>
            {#each metrics?.sessionStreams ?? [] as row (row.sessionId)}
              <tr class='border-b border-border/50'>
                <td class='py-2 pr-3 font-mono'>{shortSessionId(row.sessionId)}</td>
                <td class='py-2 pr-3'>{row.activeStreams}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </div>
</div>
