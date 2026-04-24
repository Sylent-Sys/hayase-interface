<script lang='ts'>
  import { getContext } from 'svelte'

  import type { MediaInfo } from './util'

  import { beforeNavigate, goto } from '$app/navigation'
  import EpisodesList from '$lib/components/EpisodesList.svelte'
  import * as Sheet from '$lib/components/ui/sheet'
  import { client } from '$lib/modules/anilist'
  import { episodes as eps } from '$lib/modules/anizip'
  import { click } from '$lib/modules/navigate'

  export let portal: HTMLElement
  let episodeListOpen = false

  export let mediaInfo: MediaInfo

  const stopProgressBar = getContext<() => void>('stop-progress-bar')
  beforeNavigate(({ cancel }) => {
    if (episodeListOpen) {
      episodeListOpen = false
      cancel()
      stopProgressBar()
    }
  })
</script>

<div class='text-white text-lg font-normal leading-none line-clamp-1 hover:text-neutral-300 hover:underline cursor-pointer text-shadow-lg' use:click={() => goto(`/app/anime/${mediaInfo.media.id}`)}>{mediaInfo.session.title}</div>
<Sheet.Root {portal} bind:open={episodeListOpen}>
  <Sheet.Trigger id='episode-list-button' data-down='#player-seekbar' class='inline-flex w-full items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-left text-sm font-light leading-tight text-[rgba(217,217,217,0.75)] transition-colors hover:bg-white/10 hover:text-white active:bg-white/15 touch-manipulation sm:w-auto'>{mediaInfo.session.description}</Sheet.Trigger>
  <Sheet.Content class='w-full sm:w-[550px] h-[100svh] sm:h-full p-3 sm:p-6 max-w-full max-h-[100svh] sm:max-h-full overflow-y-scroll flex flex-col !pb-0 shrink-0 gap-0 bg-black justify-between overflow-x-clip rounded-none sm:rounded-l-xl'>
    <div class='contents' on:wheel|stopPropagation>
      {#if mediaInfo.media}
        {#await Promise.all([eps(mediaInfo.media.id), client.single(mediaInfo.media.id)]) then [eps, media]}
          {#if media.data?.Media}
            <EpisodesList {eps} media={media.data.Media} />
          {/if}
        {/await}
      {/if}
    </div>
  </Sheet.Content>
</Sheet.Root>
