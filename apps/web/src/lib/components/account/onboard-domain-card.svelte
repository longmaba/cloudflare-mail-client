<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import { invalidateAll } from '$app/navigation';
	import GlobeIcon from '@lucide/svelte/icons/globe';
	import * as Card from '$lib/components/ui/card/index.js';
	import DomainOnboarder from '$lib/components/admin/domain-onboarder.svelte';
</script>

<Card.Card>
	<Card.CardHeader>
		<Card.CardTitle class="flex items-center gap-2">
			<GlobeIcon class="size-4" /> Onboard a mail domain
		</Card.CardTitle>
		<Card.CardDescription>
			Activate the mail domain selected during setup. Pilot installs create subdomain DNS
			and exact recipient rules while keeping the existing apex mail provider.
		</Card.CardDescription>
	</Card.CardHeader>
	<Card.CardContent>
		<DomainOnboarder onChange={() => invalidateAll()} />
	</Card.CardContent>
</Card.Card>
