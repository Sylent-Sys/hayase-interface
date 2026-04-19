import { redirect } from '@sveltejs/kit'

import { SETUP_VERSION } from '$lib'
import { outdatedComponent } from '$lib/modules/update'

export async function load () {
  if (Number(localStorage.getItem('setup-finished')) < SETUP_VERSION) redirect(307, '/setup')

  if (await outdatedComponent) redirect(307, '/update/')
}
