import { redirect } from '@sveltejs/kit'

import { SETUP_VERSION } from '$lib'
import { outdatedComponent } from '$lib/modules/update'

export async function load () {
  if (typeof localStorage !== 'undefined') localStorage.setItem('setup-finished', SETUP_VERSION.toString())

  if (await outdatedComponent) redirect(307, '/update/')
}
