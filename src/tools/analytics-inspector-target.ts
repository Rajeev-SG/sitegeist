type TabCandidate = Pick<chrome.tabs.Tab, "active" | "id" | "lastAccessed">;

type AnalyticsTargetSnapshot = {
	pageUrl: string;
};

type SnapshotCollector<TSnapshot extends AnalyticsTargetSnapshot> = (tabId: number) => Promise<TSnapshot>;

function sortTabsByPriority(tabs: TabCandidate[]): TabCandidate[] {
	return [...tabs].sort((left, right) => {
		if (left.active !== right.active) {
			return left.active ? -1 : 1;
		}

		return (right.lastAccessed || 0) - (left.lastAccessed || 0);
	});
}

export function isInspectablePageUrl(url: string | undefined): boolean {
	return Boolean(
		url &&
			!url.startsWith("chrome-extension://") &&
			!url.startsWith("moz-extension://") &&
			!url.startsWith("chrome://"),
	);
}

export function getCandidateTabIds(currentWindowTabs: TabCandidate[], allTabs: TabCandidate[]): number[] {
	const ids = new Set<number>();
	const orderedTabs = [...sortTabsByPriority(currentWindowTabs), ...sortTabsByPriority(allTabs)];

	for (const tab of orderedTabs) {
		if (tab.id) {
			ids.add(tab.id);
		}
	}

	return Array.from(ids);
}

export async function findInspectableAnalyticsTarget<TSnapshot extends AnalyticsTargetSnapshot>(
	currentWindowTabs: TabCandidate[],
	allTabs: TabCandidate[],
	collectSnapshot: SnapshotCollector<TSnapshot>,
): Promise<{ snapshot: TSnapshot; tabId: number }> {
	for (const tabId of getCandidateTabIds(currentWindowTabs, allTabs)) {
		try {
			const snapshot = await collectSnapshot(tabId);
			if (isInspectablePageUrl(snapshot.pageUrl)) {
				return { snapshot, tabId };
			}
		} catch {
			// Ignore tabs that Chrome refuses to script, such as browser-internal pages.
		}
	}

	throw new Error("No inspectable page tab found in the browser");
}
