import { redirect } from '@sveltejs/kit'

import { outdatedComponent } from '$lib/modules/update'

export async function load () {
  if (await outdatedComponent) return redirect(307, '/update/')

  return { goto: '/app/home/' }
}
